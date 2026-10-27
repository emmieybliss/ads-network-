import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { approvePayout, confirmPayment, failPayment, finalizeEarnings, manualAdjustment, markPayoutFailed, markPayoutPaid, markPayoutProcessing, reconcile, refundPayment, rejectPayout, settleCampaign } from '@blissnova/billing';
import { formatMicros, formatMoney, toMicros } from '@blissnova/shared';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { bodyOf, idParams, moneyString, paramsOf, queryOf, toCsv } from '../../lib/http';
import { tx } from '../../lib/tx';
import { requireUser } from '../../plugins/auth';
import { notifyOrg } from '../../services/notifications';
import { adminList, guard, meta, mgmt, reasonRequired, sortSql, Where } from './common';

const confirmBody = z.object({ reason: z.string().trim().min(3).max(1000), providerRef: z.string().trim().min(3).max(120) });
const refundBody = z.object({ amount: moneyString, reason: z.string().trim().min(3).max(1000) });
const adjustBody = z.object({ orgId: z.uuid(), account: z.enum(['advertiser_wallet', 'publisher_available']), amount: z.string().regex(/^-?\d{1,12}(\.\d{1,6})?$/), reason: z.string().trim().min(10).max(1000) });
const paidBody = z.object({ providerRef: z.string().trim().min(3).max(120), reason: z.string().trim().min(3).max(1000) });
const processingBody = z.object({ provider: z.string().trim().min(2).max(40).default('manual'), providerRef: z.string().trim().max(120).optional() });

export async function adminFinanceRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;

  function idemKey(req: { headers: Record<string, unknown> }) {
    const k = req.headers['idempotency-key'];
    if (typeof k !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(k)) throw badRequest('An Idempotency-Key header is required');
    return k;
  }

  app.get('/admin/finance/summary', { preHandler: guard('admin:finance:read'), schema: { tags: ['admin: finance'] } }, async () => {
    const balances = (await db.query(`SELECT a.kind, a.currency, (CASE WHEN a.kind = 'cash_clearing' THEN sum(e.amount_micros) ELSE -sum(e.amount_micros) END)::text AS balance FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id GROUP BY a.kind, a.currency ORDER BY a.currency, a.kind`)).rows;
    const payments = (await db.query(`SELECT status, currency, count(*)::int AS n, sum(amount_micros)::text AS total FROM payments GROUP BY status, currency`)).rows;
    const payouts = (await db.query(`SELECT status, currency, count(*)::int AS n, sum(amount_micros)::text AS total FROM payouts GROUP BY status, currency`)).rows;
    const unsettled = (await db.query(`SELECT currency, count(*)::int AS n, COALESCE(sum(cost_micros), 0)::text AS total FROM ad_events WHERE billable AND settlement_id IS NULL GROUP BY currency`)).rows;
    return { data: { balances, payments, payouts, unsettled } };
  });

  app.get('/admin/finance/payments', { preHandler: guard('admin:finance:read'), schema: { tags: ['admin: finance'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const w = new Where();
    if (q.status) w.add('p.status = ?', q.status);
    if (q.q) w.add('(o.name ILIKE ? OR p.provider_ref ILIKE ?)', `%${q.q}%`);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM payments p JOIN organizations o ON o.id = p.org_id ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(`SELECT p.*, o.name AS org_name FROM payments p JOIN organizations o ON o.id = p.org_id ${w.sql} ${sortSql(q, { created: 'p.created_at', amount: 'p.amount_micros' }, 'created')}`, w.params)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  app.post('/admin/finance/payments/:id/confirm', { config: mgmt, preHandler: guard('admin:finance:manage', { stepUp: true }), schema: { tags: ['admin: finance'], params: idParams, body: confirmBody, description: 'Confirm receipt of a manual bank transfer. Only for providers without webhooks.' } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, confirmBody);
    const s = await ctx.settings.get();
    const p = (await db.query('SELECT * FROM payments WHERE id = $1', [id])).rows[0];
    if (!p) throw notFound();
    const provider = ctx.payments.get(p.provider);
    if (provider?.status().supportsWebhooks) throw conflict('Payments from this provider are confirmed only by verified provider webhooks');
    const res = await tx(ctx, async (c) => {
      const r = await confirmPayment(c, { paymentId: id, actor: { type: 'user', userId: actor.id }, feeBps: s.pricing.advertiserFeeBps, providerRef: b.providerRef, note: b.reason, invoicePrefix: s.pricing.invoicePrefix });
      await audit(c, req, { action: 'payment.manual_confirm', resourceType: 'payment', resourceId: id, orgId: p.org_id, after: { providerRef: b.providerRef, amount: p.amount_micros }, reason: b.reason });
      return r;
    });
    if (res.created) await notifyOrg(ctx, p.org_id, { type: 'payment_confirmed', title: 'Payment received', link: '/advertiser/billing', template: 'payment_confirmed', vars: { amount: formatMoney(p.amount_micros, p.currency) }, roles: ['owner'] }).catch(() => undefined);
    return { data: res.payment };
  });

  app.post('/admin/finance/payments/:id/fail', { config: mgmt, preHandler: guard('admin:finance:manage'), schema: { tags: ['admin: finance'], params: idParams, body: reasonRequired } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const { reason } = bodyOf(req, reasonRequired);
    await failPayment(db as never, id, reason);
    await audit(db, req, { action: 'payment.mark_failed', resourceType: 'payment', resourceId: id, reason });
    return { ok: true };
  });

  app.post('/admin/finance/payments/:id/refund', { config: mgmt, preHandler: guard('admin:finance:manage', { stepUp: true }), schema: { tags: ['admin: finance'], params: idParams, body: refundBody, description: 'Record a refund issued through the provider or bank. Debits the advertiser wallet.' } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, refundBody);
    const key = idemKey(req);
    const s = await ctx.settings.get();
    const p = (await db.query('SELECT confirmed_at, org_id FROM payments WHERE id = $1', [id])).rows[0];
    if (!p) throw notFound();
    if (p.confirmed_at && Date.now() - new Date(p.confirmed_at).getTime() > s.pricing.refundWindowDays * 86_400_000) throw conflict(`Refunds are allowed within ${s.pricing.refundWindowDays} days of payment`);
    const res = await tx(ctx, async (c) => {
      const r = await refundPayment(c, { paymentId: id, amount: toMicros(b.amount), actor: { type: 'user', userId: actor.id }, reason: b.reason, idempotencyKey: `${id}:${key}`, invoicePrefix: s.pricing.invoicePrefix });
      await audit(c, req, { action: 'payment.refund', resourceType: 'payment', resourceId: id, orgId: p.org_id, after: { amount: b.amount }, reason: b.reason });
      return r;
    });
    return { data: res.refund };
  });

  app.get('/admin/finance/webhooks', { preHandler: guard('admin:finance:read'), schema: { tags: ['admin: finance'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM payment_webhook_events`)).rows[0].n);
    const rows = (await db.query(`SELECT id, provider, provider_event_id, type, signature_valid, processed_at, processing_error, received_at FROM payment_webhook_events ${sortSql(q, { received: 'received_at' }, 'received')}`)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  app.get('/admin/finance/ledger', { preHandler: guard('admin:finance:read'), schema: { tags: ['admin: finance'], querystring: adminList.extend({ orgId: z.uuid().optional(), txnType: z.string().max(40).optional() }) } }, async (req) => {
    const q = queryOf(req, adminList.extend({ orgId: z.uuid().optional(), txnType: z.string().max(40).optional() }));
    const w = new Where();
    if (q.orgId) w.add('t.id IN (SELECT e2.transaction_id FROM ledger_entries e2 JOIN ledger_accounts a2 ON a2.id = e2.account_id WHERE a2.org_id = ?)', q.orgId);
    if (q.txnType) w.add('t.type = ?', q.txnType);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM ledger_transactions t ${w.sql}`, w.params)).rows[0].n);
    const txns = (await db.query(`SELECT t.*, u.name AS actor_name FROM ledger_transactions t LEFT JOIN users u ON u.id = t.actor_user_id ${w.sql} ${sortSql(q, { created: 't.created_at' }, 'created')}`, w.params)).rows;
    const ids = txns.map((t) => t.id);
    const entries = ids.length ? (await db.query(`SELECT e.transaction_id, e.amount_micros, a.kind, a.org_id, a.campaign_id, o.name AS org_name FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id LEFT JOIN organizations o ON o.id = a.org_id WHERE e.transaction_id = ANY($1) ORDER BY e.id`, [ids])).rows : [];
    return { data: txns.map((t) => ({ ...t, entries: entries.filter((e) => e.transaction_id === t.id) })), meta: meta(q, total) };
  });

  app.post('/admin/finance/adjustments', { config: mgmt, preHandler: guard('admin:finance:manage', { stepUp: true }), schema: { tags: ['admin: finance'], body: adjustBody } }, async (req, reply) => {
    const actor = requireUser(req);
    const b = bodyOf(req, adjustBody);
    const key = idemKey(req);
    const org = (await db.query('SELECT type, currency FROM organizations WHERE id = $1', [b.orgId])).rows[0];
    if (!org) throw notFound();
    if ((b.account === 'advertiser_wallet') !== (org.type === 'advertiser')) throw badRequest('Account does not match the organization type');
    const res = await tx(ctx, async (c) => {
      const r = await manualAdjustment(c, { orgId: b.orgId, kind: b.account, currency: org.currency, amount: toMicros(b.amount), actor: { type: 'user', userId: actor.id }, reason: b.reason, idempotencyKey: `${b.orgId}:${key}` });
      await audit(c, req, { action: 'ledger.adjustment', resourceType: 'organization', resourceId: b.orgId, orgId: b.orgId, after: { account: b.account, amount: b.amount, transactionId: r.id }, reason: b.reason });
      return r;
    });
    return reply.status(201).send({ data: res });
  });

  app.get('/admin/finance/reconciliation', { preHandler: guard('admin:finance:read'), schema: { tags: ['admin: finance'] } }, async () => {
    const checks = await reconcile(db);
    return { data: { ok: checks.every((c) => c.ok), checks, ranAt: new Date().toISOString() } };
  });

  app.post('/admin/finance/settle', { config: mgmt, preHandler: guard('admin:finance:manage'), schema: { tags: ['admin: finance'] } }, async (req) => {
    const s = await ctx.settings.get();
    const camps = (await db.query(`SELECT DISTINCT campaign_id FROM ad_events WHERE billable AND settlement_id IS NULL`)).rows;
    let settlements = 0;
    for (const c of camps) settlements += (await tx(ctx, (cl) => settleCampaign(cl, c.campaign_id, s.publishers.earningsHoldDays))).length;
    const finalized = await tx(ctx, (cl) => finalizeEarnings(cl));
    await audit(db, req, { action: 'finance.run_settlement', resourceType: 'ledger', after: { settlements, finalized } });
    return { data: { settlements, finalized } };
  });

  app.get('/admin/finance/export', { preHandler: guard('admin:finance:read'), schema: { tags: ['admin: finance'], querystring: z.object({ kind: z.enum(['ledger', 'payments', 'payouts']), from: z.iso.date().optional(), to: z.iso.date().optional() }) } }, async (req, reply) => {
    const q = req.query as { kind: 'ledger' | 'payments' | 'payouts'; from?: string; to?: string };
    const from = q.from ?? '1970-01-01';
    const to = q.to ?? '2999-12-31';
    let rows: Array<Record<string, unknown>> = [];
    let cols: Array<{ key: string; label: string }> = [];
    if (q.kind === 'ledger') {
      rows = (await db.query(`SELECT t.id, t.created_at, t.type, t.currency, t.reference_type, t.reference_id, t.actor_type, t.reason, a.kind AS account, o.name AS organization, e.amount_micros FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id JOIN ledger_accounts a ON a.id = e.account_id LEFT JOIN organizations o ON o.id = a.org_id WHERE t.created_at::date BETWEEN $1 AND $2 ORDER BY e.id`, [from, to])).rows.map((r) => ({ ...r, amount: formatMicros(r.amount_micros, 6) }));
      cols = ['id', 'created_at', 'type', 'currency', 'account', 'organization', 'amount', 'reference_type', 'reference_id', 'actor_type', 'reason'].map((k) => ({ key: k, label: k }));
    } else if (q.kind === 'payments') {
      rows = (await db.query(`SELECT p.id, p.created_at, p.confirmed_at, o.name AS organization, p.provider, p.provider_ref, p.status, p.currency, p.amount_micros, p.fee_micros, p.refunded_micros FROM payments p JOIN organizations o ON o.id = p.org_id WHERE p.created_at::date BETWEEN $1 AND $2 ORDER BY p.created_at`, [from, to])).rows.map((r) => ({ ...r, amount: formatMicros(r.amount_micros), fee: formatMicros(r.fee_micros), refunded: formatMicros(r.refunded_micros) }));
      cols = ['id', 'created_at', 'confirmed_at', 'organization', 'provider', 'provider_ref', 'status', 'currency', 'amount', 'fee', 'refunded'].map((k) => ({ key: k, label: k }));
    } else {
      rows = (await db.query(`SELECT p.id, p.created_at, p.updated_at, o.name AS organization, p.status, p.currency, p.amount_micros, p.method_label, p.provider_ref, p.failure_reason FROM payouts p JOIN organizations o ON o.id = p.org_id WHERE p.created_at::date BETWEEN $1 AND $2 ORDER BY p.created_at`, [from, to])).rows.map((r) => ({ ...r, amount: formatMicros(r.amount_micros) }));
      cols = ['id', 'created_at', 'updated_at', 'organization', 'status', 'currency', 'amount', 'method_label', 'provider_ref', 'failure_reason'].map((k) => ({ key: k, label: k }));
    }
    await db.query('INSERT INTO data_exports (kind, requested_by, params, row_count) VALUES ($1, $2, $3, $4)', [`finance:${q.kind}`, req.auth!.user!.id, JSON.stringify(q), rows.length]);
    await audit(db, req, { action: 'data.export', resourceType: 'finance', resourceId: q.kind, after: { rows: rows.length, from, to } });
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${q.kind}-${from}-${to}.csv"`).send(toCsv(rows, cols));
  });

  app.get('/admin/finance/providers', { preHandler: guard('admin:finance:read'), schema: { tags: ['admin: finance'] } }, async () => {
    const checks = (await db.query(`SELECT DISTINCT ON (provider) provider, ok, detail, created_at FROM provider_checks ORDER BY provider, created_at DESC`)).rows;
    const known = [{ id: 'stripe', label: 'Stripe Checkout', configured: Boolean(ctx.config.STRIPE_SECRET_KEY && ctx.config.STRIPE_WEBHOOK_SECRET), supportsCheckout: true, supportsWebhooks: true, detail: 'Requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.' }];
    const list = [...ctx.payments.list().map((p) => p.status()), ...known.filter((k) => !ctx.payments.get(k.id))];
    return { data: list.map((p) => {
      const last = checks.find((c) => c.provider === p.id);
      return { ...p, lastCheck: last ?? null, connected: Boolean(p.configured && last?.ok), webhookUrl: p.supportsWebhooks ? `${ctx.config.PUBLIC_API_URL}/api/v1/webhooks/payments/${p.id}` : null };
    }) };
  });

  app.post('/admin/finance/providers/:provider/test', { config: mgmt, preHandler: guard('admin:finance:manage'), schema: { tags: ['admin: finance'], params: z.object({ provider: z.string().regex(/^[a-z_]{2,40}$/) }) } }, async (req) => {
    const { provider } = req.params as { provider: string };
    const p = ctx.payments.get(provider);
    if (!p) throw notFound('Provider is not configured');
    const r = await p.testConnection();
    await db.query('INSERT INTO provider_checks (provider, ok, detail, checked_by) VALUES ($1, $2, $3, $4)', [provider, r.ok, r.detail, req.auth!.user!.id]);
    await audit(db, req, { action: 'payment_provider.test', resourceType: 'payment_provider', resourceId: provider, after: r });
    return { data: r };
  });

  app.get('/admin/finance/invoices', { preHandler: guard('admin:finance:read'), schema: { tags: ['admin: finance'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM invoices`)).rows[0].n);
    const rows = (await db.query(`SELECT i.id, i.number, i.kind, i.status, i.currency, i.total_micros, i.issued_at, o.name AS org_name FROM invoices i JOIN organizations o ON o.id = i.org_id ${sortSql(q, { issued: 'i.issued_at' }, 'issued')}`)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  app.post('/admin/finance/invoices/:id/void', { config: mgmt, preHandler: guard('admin:finance:manage', { stepUp: true }), schema: { tags: ['admin: finance'], params: idParams, body: reasonRequired } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const { reason } = bodyOf(req, reasonRequired);
    const r = await db.query(`UPDATE invoices SET status = 'void', void_reason = $2 WHERE id = $1 AND status = 'issued' AND kind = 'statement' RETURNING org_id`, [id, reason]);
    if (!r.rowCount) throw conflict('Only issued statements can be voided; receipts and credit notes mirror ledger records');
    await audit(db, req, { action: 'invoice.void', resourceType: 'invoice', resourceId: id, orgId: r.rows[0].org_id, reason });
    return { ok: true };
  });

  // ---------------------------------------------------------------- payouts
  app.get('/admin/payouts', { preHandler: guard('admin:finance:read'), schema: { tags: ['admin: finance'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const w = new Where();
    if (q.status) w.add('p.status = ?', q.status);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM payouts p ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(`SELECT p.*, o.name AS org_name, u.name AS requested_by_name FROM payouts p JOIN organizations o ON o.id = p.org_id JOIN users u ON u.id = p.requested_by ${w.sql} ${sortSql(q, { created: 'p.created_at', amount: 'p.amount_micros' }, 'created')}`, w.params)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  async function afterPayout(p: { org_id: string; amount_micros: string; currency: string; status: string; review_reason?: string | null; failure_reason?: string | null }) {
    await notifyOrg(ctx, p.org_id, { type: 'payout_status', title: `Payout ${p.status}`, link: '/publisher/earnings', template: 'payout_status', vars: { status: p.status, amount: formatMoney(p.amount_micros, p.currency), reason: p.failure_reason ?? p.review_reason ?? '' }, roles: ['owner'] }).catch(() => undefined);
  }

  app.post('/admin/payouts/:id/approve', { config: mgmt, preHandler: guard('admin:payouts:manage', { stepUp: true }), schema: { tags: ['admin: finance'], params: idParams, body: reasonRequired } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const { reason } = bodyOf(req, reasonRequired);
    const p = await tx(ctx, async (c) => {
      const r = await approvePayout(c, id, { type: 'user', userId: actor.id }, reason);
      await audit(c, req, { action: 'payout.approve', resourceType: 'payout', resourceId: id, orgId: r.org_id, after: { status: r.status }, reason });
      return r;
    });
    await afterPayout(p);
    return { data: p };
  });

  app.post('/admin/payouts/:id/reject', { config: mgmt, preHandler: guard('admin:payouts:manage'), schema: { tags: ['admin: finance'], params: idParams, body: reasonRequired } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const { reason } = bodyOf(req, reasonRequired);
    const p = await tx(ctx, async (c) => {
      const r = await rejectPayout(c, id, { type: 'user', userId: actor.id }, reason);
      await audit(c, req, { action: 'payout.reject', resourceType: 'payout', resourceId: id, orgId: r.org_id, reason });
      return r;
    });
    await afterPayout(p);
    return { data: p };
  });

  app.post('/admin/payouts/:id/processing', { config: mgmt, preHandler: guard('admin:payouts:manage', { stepUp: true }), schema: { tags: ['admin: finance'], params: idParams, body: processingBody } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, processingBody);
    const p = await tx(ctx, async (c) => {
      const r = await markPayoutProcessing(c, id, b.provider, b.providerRef ?? null);
      await audit(c, req, { action: 'payout.processing', resourceType: 'payout', resourceId: id, orgId: r.org_id, after: b });
      return r;
    });
    return { data: p };
  });

  app.post('/admin/payouts/:id/paid', { config: mgmt, preHandler: guard('admin:payouts:manage', { stepUp: true }), schema: { tags: ['admin: finance'], params: idParams, body: paidBody, description: 'Record that funds were sent (manual payouts). Requires the bank or provider reference.' } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, paidBody);
    const p = await tx(ctx, async (c) => {
      const r = await markPayoutPaid(c, id, { type: 'user', userId: actor.id }, b.providerRef, b.reason);
      await audit(c, req, { action: 'payout.paid', resourceType: 'payout', resourceId: id, orgId: r.org_id, after: { providerRef: b.providerRef }, reason: b.reason });
      return r;
    });
    await afterPayout(p);
    return { data: p };
  });

  app.post('/admin/payouts/:id/failed', { config: mgmt, preHandler: guard('admin:payouts:manage', { stepUp: true }), schema: { tags: ['admin: finance'], params: idParams, body: reasonRequired } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const { reason } = bodyOf(req, reasonRequired);
    const p = await tx(ctx, async (c) => {
      const r = await markPayoutFailed(c, id, { type: 'user', userId: actor.id }, reason);
      await audit(c, req, { action: 'payout.failed', resourceType: 'payout', resourceId: id, orgId: r.org_id, reason });
      return r;
    });
    await afterPayout(p);
    return { data: p };
  });
}
