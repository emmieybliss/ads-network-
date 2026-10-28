import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { approvePayout, confirmPayment, failPayment, finalizeEarnings, manualAdjustment, markPayoutFailed, markPayoutPaid, markPayoutProcessing, reconcile, refundPayment, rejectPayout, settleCampaign } from '@blissnova/billing';
import { CRYPTO_NETWORKS, formatMicros, formatMoney, isValidTxHash, toMicros } from '@blissnova/shared';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound, providerError } from '../../lib/errors';
import { bodyOf, idParams, moneyString, paramsOf, queryOf, toCsv } from '../../lib/http';
import { tx } from '../../lib/tx';
import { requireUser } from '../../plugins/auth';
import { notifyOrg } from '../../services/notifications';
import { DevSimulatedPayoutProvider } from '../../services/payouts/dev';
import { decryptDestination, handlePayoutWebhook, PayoutSendError, sendPayout, type PayoutCtx } from '../../services/payouts/service';
import { adminList, guard, meta, mgmt, reasonRequired, sortSql, Where } from './common';

const confirmBody = z.object({ reason: z.string().trim().min(3).max(1000), providerRef: z.string().trim().min(3).max(120) });
const refundBody = z.object({ amount: moneyString, reason: z.string().trim().min(3).max(1000) });
const adjustBody = z.object({ orgId: z.uuid(), account: z.enum(['advertiser_wallet', 'publisher_available']), amount: z.string().regex(/^-?\d{1,12}(\.\d{1,6})?$/), reason: z.string().trim().min(10).max(1000) });
const paidBody = z.object({ providerRef: z.string().trim().min(3).max(120), reason: z.string().trim().min(3).max(1000) });
const sendBody = z.object({ provider: z.string().regex(/^[a-z_]{2,40}$/) });
const simulateBody = z.object({ outcome: z.enum(['paid', 'failed']) });
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
    const p = (await db.query('SELECT id, confirmed_at, org_id, provider, provider_charge_ref, currency, status, amount_micros, refunded_micros FROM payments WHERE id = $1', [id])).rows[0];
    if (!p) throw notFound();
    if (p.confirmed_at && Date.now() - new Date(p.confirmed_at).getTime() > s.pricing.refundWindowDays * 86_400_000) throw conflict(`Refunds are allowed within ${s.pricing.refundWindowDays} days of payment`);
    const amount = toMicros(b.amount);
    // Card and PayPal payments are refunded through the provider first (idempotent per key);
    // the ledger is debited only once the provider accepted the refund.
    const provider = ctx.payments.get(p.provider);
    let providerRef: string | undefined;
    const prior = (await db.query('SELECT 1 FROM refunds WHERE idempotency_key = $1', [`${id}:${key}`])).rowCount;
    if (provider?.refund && !prior) {
      if (!['succeeded', 'partially_refunded'].includes(p.status)) throw conflict('Only settled payments can be refunded');
      if (amount <= 0n || amount > BigInt(p.amount_micros) - BigInt(p.refunded_micros)) throw conflict('Refund exceeds the refundable amount of this payment');
      const w = (await db.query<{ t: string }>(`SELECT COALESCE(-sum(e.amount_micros), 0)::text AS t FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'advertiser_wallet' AND a.org_id = $1 AND a.currency = $2`, [p.org_id, p.currency])).rows[0]!.t;
      if (BigInt(w) < amount) throw conflict('Refund exceeds the unreserved wallet balance. Release campaign budgets first.');
      try {
        providerRef = (await provider.refund(p, amount, `${id}:${key}`)).providerRef;
      } catch (err) {
        await audit(db, req, { action: 'payment.refund_failed', resourceType: 'payment', resourceId: id, orgId: p.org_id, after: { error: (err as Error).message } });
        throw providerError((err as Error).message);
      }
    }
    const res = await tx(ctx, async (c) => {
      const r = await refundPayment(c, { paymentId: id, amount, actor: { type: 'user', userId: actor.id }, reason: b.reason, idempotencyKey: `${id}:${key}`, invoicePrefix: s.pricing.invoicePrefix, providerRef });
      await audit(c, req, { action: 'payment.refund', resourceType: 'payment', resourceId: id, orgId: p.org_id, after: { amount: b.amount, provider: provider?.refund ? p.provider : 'recorded', providerRef }, reason: b.reason });
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
    const known = [
      { id: 'stripe', label: 'Card (Stripe)', configured: Boolean(ctx.config.STRIPE_SECRET_KEY && ctx.config.STRIPE_WEBHOOK_SECRET), supportsCheckout: true, supportsWebhooks: true, detail: 'Requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.' },
      { id: 'paypal', label: 'PayPal', configured: false, supportsCheckout: true, supportsWebhooks: true, detail: 'Requires PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID.' },
    ];
    const list = [...ctx.payments.list().map((p) => p.status()), ...known.filter((k) => !ctx.payments.get(k.id))];
    return { data: list.map((p) => {
      const last = checks.find((c) => c.provider === p.id);
      return { ...p, lastCheck: last ?? null, connected: Boolean(p.configured && last?.ok), webhookUrl: p.supportsWebhooks ? `${ctx.config.PUBLIC_API_URL}/api/v1/webhooks/${p.id === 'paypal' ? 'paypal' : `payments/${p.id}`}` : null };
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
    const rows = (await db.query(`SELECT p.*, o.name AS org_name, u.name AS requested_by_name, pp.details_changed_at FROM payouts p JOIN organizations o ON o.id = p.org_id JOIN users u ON u.id = p.requested_by LEFT JOIN payout_profiles pp ON pp.org_id = p.org_id ${w.sql} ${sortSql(q, { created: 'p.created_at', amount: 'p.amount_micros' }, 'created')}`, w.params)).rows;
    const providers = ctx.payouts.list().filter((x) => x.status().configured);
    return {
      data: rows.map(({ destination_encrypted, ...r }) => ({
        ...r,
        has_destination: Boolean(destination_encrypted),
        // Details changed within a week of the request: worth a second look before paying.
        details_recently_changed: Boolean(r.details_changed_at && new Date(r.created_at).getTime() - new Date(r.details_changed_at).getTime() < 7 * 86_400_000),
        send_options: destination_encrypted ? providers.filter((x) => x.methods.includes(r.method) && (!x.supportsCurrency || x.supportsCurrency(r.currency))).map((x) => ({ id: x.id, label: x.label, mode: x.status().mode })) : [],
      })),
      meta: meta(q, total),
    };
  });

  const payoutCtx: PayoutCtx = { ...ctx, notify: (orgId, n) => notifyOrg(ctx, orgId, n) };

  app.get('/admin/finance/payout-providers', { preHandler: guard('admin:finance:read'), schema: { tags: ['admin: finance'] } }, async () => {
    const list = ctx.payouts.list().map((p) => p.status());
    if (!ctx.payouts.get('paypal')) list.push({ id: 'paypal', label: 'PayPal Payouts', configured: false, methods: ['paypal'], mode: ctx.config.PAYPAL_ENV === 'live' ? 'live' : 'test', supportsWebhooks: true, detail: 'Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID, and enable Payouts on the PayPal business account.' });
    return { data: { providers: list.map((p) => ({ ...p, webhookUrl: p.id === 'paypal' ? `${ctx.config.PUBLIC_API_URL}/api/v1/webhooks/paypal` : null })), manual: ['bank_transfer', 'crypto'] } };
  });

  app.post('/admin/payouts/:id/send', { config: mgmt, preHandler: guard('admin:payouts:manage', { stepUp: true }), schema: { tags: ['admin: finance'], params: idParams, body: sendBody, description: 'Send an approved payout through a payout provider (PayPal Payouts, or the development simulator). The provider call is idempotent per payout.' } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const { provider } = bodyOf(req, sendBody);
    try {
      const r = await sendPayout(payoutCtx, id, provider, { type: 'user', userId: actor.id });
      await audit(db, req, { action: 'payout.send', resourceType: 'payout', resourceId: id, orgId: r.org_id, after: { provider, status: r.status, providerRef: r.provider_ref } });
      const { destination_encrypted: _d, ...out } = r;
      return { data: out };
    } catch (err) {
      if (err instanceof PayoutSendError) {
        await audit(db, req, { action: 'payout.send_failed', resourceType: 'payout', resourceId: id, after: { provider, error: err.message } });
        throw providerError(err.message);
      }
      throw err;
    }
  });

  app.get('/admin/payouts/:id/destination', { preHandler: guard('admin:payouts:manage', { stepUp: true }), schema: { tags: ['admin: finance'], params: idParams, description: 'Full payout destination, for staff paying manually by bank transfer or crypto. Every view is audited.' } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const p = (await db.query('SELECT id, org_id, method, method_label, destination_encrypted FROM payouts WHERE id = $1', [id])).rows[0];
    if (!p) throw notFound();
    const d = decryptDestination(ctx.config.ENCRYPTION_KEY, p.destination_encrypted);
    await audit(db, req, { action: 'payout.destination_viewed', resourceType: 'payout', resourceId: id, orgId: p.org_id, after: { label: p.method_label } });
    return { data: d ? { ...d, ...(d.method === 'crypto' ? { networkLabel: CRYPTO_NETWORKS[d.network].label } : {}) } : null };
  });

  app.get('/admin/payouts/export', { preHandler: guard('admin:payouts:manage', { stepUp: true }), schema: { tags: ['admin: finance'], querystring: z.object({ method: z.enum(['bank_transfer', 'crypto']) }), description: 'CSV of approved payouts with full destination details, for a bulk bank upload or a wallet batch. Audited.' } }, async (req, reply) => {
    const { method } = req.query as { method: 'bank_transfer' | 'crypto' };
    const rows = (await db.query(`SELECT p.id, p.amount_micros, p.currency, p.destination_encrypted, o.name AS organization FROM payouts p JOIN organizations o ON o.id = p.org_id WHERE p.status = 'approved' AND p.method = $1 ORDER BY p.created_at`, [method])).rows;
    const out = rows.map((r) => {
      const d = decryptDestination(ctx.config.ENCRYPTION_KEY, r.destination_encrypted) as Record<string, string> | null;
      return { payout_id: r.id, organization: r.organization, amount: formatMicros(r.amount_micros), currency: r.currency, reference: `PAYOUT-${String(r.id).slice(0, 8).toUpperCase()}`, ...(d ?? {}) };
    });
    const cols = method === 'bank_transfer'
      ? ['payout_id', 'organization', 'amount', 'currency', 'reference', 'accountHolder', 'bankName', 'country', 'iban', 'accountNumber', 'routingNumber', 'swift']
      : ['payout_id', 'organization', 'amount', 'currency', 'reference', 'asset', 'network', 'address', 'memo'];
    await audit(db, req, { action: 'payout.export', resourceType: 'payout', resourceId: method, after: { rows: out.length } });
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="approved-${method}-payouts.csv"`).send(toCsv(out, cols.map((c) => ({ key: c, label: c }))));
  });

  // Development only: report the outcome of a simulated payout through the signed webhook path.
  app.post('/admin/payouts/:id/simulate', { config: mgmt, preHandler: guard('admin:payouts:manage'), schema: { tags: ['admin: finance'], params: idParams, body: simulateBody, hide: ctx.config.isProd } }, async (req) => {
    const provider = ctx.payouts.get('dev_simulated');
    if (!(provider instanceof DevSimulatedPayoutProvider)) throw notFound();
    const { id } = paramsOf(req, idParams);
    const p = (await db.query(`SELECT id, status FROM payouts WHERE id = $1 AND provider = 'dev_simulated'`, [id])).rows[0];
    if (!p) throw notFound();
    if (p.status !== 'processing') throw conflict('Only a simulated payout that is processing can be completed');
    const { outcome } = bodyOf(req, simulateBody);
    const body = JSON.stringify({ id: `devpayoutevt_${id}_${outcome}`, payoutId: id, outcome, reason: outcome === 'failed' ? 'Simulated failure' : undefined });
    const res = await handlePayoutWebhook(payoutCtx, 'dev_simulated', Buffer.from(body), { 'x-dev-signature': provider.sign(body) });
    return { ok: res.status === 200, simulated: true };
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
      const cur = (await c.query('SELECT method, destination_encrypted FROM payouts WHERE id = $1', [id])).rows[0];
      if (cur?.method === 'crypto') {
        const d = decryptDestination(ctx.config.ENCRYPTION_KEY, cur.destination_encrypted);
        if (d?.method === 'crypto' && !isValidTxHash(d.network, b.providerRef)) throw badRequest(`Enter the ${CRYPTO_NETWORKS[d.network].label} transaction hash of the transfer`);
      }
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
