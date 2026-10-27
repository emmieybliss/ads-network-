import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { balance } from '@blissnova/billing';
import { formatMoney, toMicros, MICROS_PER_MINOR } from '@blissnova/shared';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { bodyOf, idParams, moneyString, orgIdParams, orgParams, paramsOf } from '../lib/http';
import { requireOrg, requireUser } from '../plugins/auth';
import { handlePaymentWebhook } from '../services/payments/webhook';
import { DevSimulatedProvider } from '../services/payments/dev';

const fundBody = z.object({ amount: moneyString, provider: z.string().max(40) });
const disputeBody = z.object({ subjectType: z.enum(['campaign', 'payment', 'invoice', 'payout', 'other']), subjectId: z.uuid().optional(), body: z.string().trim().min(10).max(5000) });

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function billingRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const mgmt = { rateLimit: { bucket: 'management' as const } };
  const adv = { type: 'advertiser' as const };

  app.get('/orgs/:orgId/billing', { preHandler: requireOrg('billing:read', { ...adv, allowSuspended: true }), schema: { tags: ['billing'], params: orgParams } }, async (req) => {
    const org = req.org!;
    const wallet = await balance(db as never, { kind: 'advertiser_wallet', orgId: org.id }, org.currency);
    const reserved = (await db.query<{ t: string }>(
      `SELECT COALESCE(-sum(e.amount_micros), 0)::text AS t FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'campaign_reserve' AND a.org_id = $1 AND a.currency = $2`, [org.id, org.currency])).rows[0]!.t;
    const pending = (await db.query<{ t: string }>(`SELECT COALESCE(sum(amount_micros), 0)::text AS t FROM payments WHERE org_id = $1 AND status = 'pending'`, [org.id])).rows[0]!.t;
    const spend = (await db.query<{ t: string; m: string }>(`SELECT COALESCE(sum(spent_micros), 0)::text AS t, '0' AS m FROM campaigns WHERE org_id = $1`, [org.id])).rows[0]!.t;
    const providers = ctx.payments.list().map((p) => p.status()).filter((p) => p.configured);
    return { data: { currency: org.currency, availableMicros: wallet.toString(), reservedMicros: reserved, pendingPaymentsMicros: pending, lifetimeSpendMicros: spend, providers } };
  });

  app.get('/orgs/:orgId/billing/payments', { preHandler: requireOrg('billing:read', { ...adv, allowSuspended: true }), schema: { tags: ['billing'], params: orgParams } }, async (req) => {
    const rows = (await db.query(`SELECT id, provider, provider_ref, amount_micros, fee_micros, currency, status, refunded_micros, checkout_url, failure_reason, created_at, confirmed_at FROM payments WHERE org_id = $1 ORDER BY created_at DESC LIMIT 200`, [req.org!.id])).rows;
    return { data: rows };
  });

  app.post('/orgs/:orgId/billing/payments', { config: mgmt, preHandler: requireOrg('billing:fund', adv), schema: { tags: ['billing'], params: orgParams, body: fundBody, description: 'Start a funding payment. Funds are credited only after the provider confirms by verified webhook, or after finance staff confirm a manual transfer.' } }, async (req, reply) => {
    const user = requireUser(req);
    const b = bodyOf(req, fundBody);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw badRequest('An Idempotency-Key header is required');
    const provider = ctx.payments.get(b.provider);
    if (!provider || !provider.status().configured) throw badRequest('That payment method is not available');
    const amount = toMicros(b.amount);
    if (amount % MICROS_PER_MINOR !== 0n) throw badRequest('Enter an amount with at most two decimal places');
    const s = await ctx.settings.get();
    if (amount < BigInt(s.pricing.minCampaignBudgetMicros) / 10n || amount > 1_000_000n * 1_000_000n) throw badRequest('Amount is outside the allowed range');
    const idem = `${req.org!.id}:${key}`;
    const existing = (await db.query('SELECT * FROM payments WHERE idempotency_key = $1', [idem])).rows[0];
    if (existing) return { data: existing };
    const id = randomUUID();
    const checkout = await provider.createCheckout({
      paymentId: id, orgId: req.org!.id, amountMicros: amount, currency: req.org!.currency, description: `${s.branding.productName} account funding`,
      successUrl: `${ctx.config.PUBLIC_SITE_URL}/advertiser/billing?payment=${id}&status=returned`, cancelUrl: `${ctx.config.PUBLIC_SITE_URL}/advertiser/billing?payment=${id}&status=cancelled`,
    });
    const row = (await db.query(
      `INSERT INTO payments (id, org_id, provider, provider_ref, idempotency_key, amount_micros, currency, checkout_url, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, req.org!.id, provider.id, checkout.providerRef, idem, amount.toString(), req.org!.currency, checkout.checkoutUrl, user.id])).rows[0];
    await audit(db, req, { action: 'payment.create', resourceType: 'payment', resourceId: id, orgId: req.org!.id, after: { provider: provider.id, amount: amount.toString() } });
    return reply.status(201).send({ data: { ...row, instructions: checkout.instructions ?? null } });
  });

  app.get('/orgs/:orgId/billing/invoices', { preHandler: requireOrg('billing:read', { ...adv, allowSuspended: true }), schema: { tags: ['billing'], params: orgParams } }, async (req) => {
    const rows = (await db.query(`SELECT id, number, kind, status, currency, total_micros, period_start, period_end, payment_id, issued_at FROM invoices WHERE org_id = $1 ORDER BY issued_at DESC LIMIT 200`, [req.org!.id])).rows;
    return { data: rows };
  });

  app.get('/orgs/:orgId/billing/invoices/:id/download', { preHandler: requireOrg('billing:read', { ...adv, allowSuspended: true }), schema: { tags: ['billing'], params: orgIdParams } }, async (req, reply) => {
    const { id } = paramsOf(req, orgIdParams);
    const inv = (await db.query('SELECT i.*, o.name AS org_name, o.billing_email FROM invoices i JOIN organizations o ON o.id = i.org_id WHERE i.id = $1 AND i.org_id = $2', [id, req.org!.id])).rows[0];
    if (!inv) throw notFound();
    const s = await ctx.settings.get();
    const lines = (inv.lines as Array<{ description: string; amountMicros: string }>).map((l) => `<tr><td>${esc(l.description)}</td><td class="r">${esc(formatMoney(l.amountMicros, inv.currency))}</td></tr>`).join('');
    const title = inv.kind === 'receipt' ? 'Payment receipt' : inv.kind === 'credit_note' ? 'Credit note' : 'Statement';
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} ${esc(inv.number)}</title><style>body{font:14px/1.5 system-ui,sans-serif;color:#0f172a;max-width:720px;margin:40px auto;padding:0 16px}h1{font-size:22px}table{width:100%;border-collapse:collapse;margin-top:24px}td,th{border-bottom:1px solid #e2e8f0;padding:8px 0;text-align:left}.r{text-align:right}.muted{color:#64748b}</style></head><body>
<h1>${esc(title)}</h1><p class="muted">${esc(s.branding.companyName)} · ${esc(s.branding.productName)}<br>Support: ${esc(s.branding.supportEmail)}</p>
<p><strong>Number:</strong> ${esc(inv.number)}<br><strong>Issued:</strong> ${esc(new Date(inv.issued_at).toISOString().slice(0, 10))}<br><strong>Billed to:</strong> ${esc(inv.org_name)}${inv.billing_email ? ` (${esc(inv.billing_email)})` : ''}<br><strong>Status:</strong> ${esc(inv.status)}</p>
<table><thead><tr><th>Description</th><th class="r">Amount</th></tr></thead><tbody>${lines}</tbody><tfoot><tr><th>Total</th><th class="r">${esc(formatMoney(inv.total_micros, inv.currency))}</th></tr></tfoot></table>
<p class="muted">This document was generated from ledger records. Tax details are not included; consult your local requirements.</p></body></html>`;
    return reply.type('text/html; charset=utf-8').header('content-disposition', `attachment; filename="${inv.number}.html"`).header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'").send(html);
  });

  app.get('/orgs/:orgId/billing/ledger', { preHandler: requireOrg('billing:read', { ...adv, allowSuspended: true }), schema: { tags: ['billing'], params: orgParams } }, async (req) => {
    const rows = (await db.query(
      `SELECT t.id AS transaction_id, t.type, t.reason, t.reference_type, t.reference_id, t.created_at, a.kind AS account, a.campaign_id, e.amount_micros
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id JOIN ledger_transactions t ON t.id = e.transaction_id
       WHERE a.org_id = $1 ORDER BY e.id DESC LIMIT 500`, [req.org!.id])).rows;
    // Present credits to the organization's accounts as positive amounts.
    return { data: rows.map((r) => ({ ...r, amount_micros: (-BigInt(r.amount_micros)).toString() })) };
  });

  app.get('/orgs/:orgId/billing/refunds', { preHandler: requireOrg('billing:read', { ...adv, allowSuspended: true }), schema: { tags: ['billing'], params: orgParams } }, async (req) => {
    const rows = (await db.query(`SELECT id, payment_id, amount_micros, currency, status, reason, created_at FROM refunds WHERE org_id = $1 ORDER BY created_at DESC`, [req.org!.id])).rows;
    return { data: rows };
  });

  // Disputes (advertisers and publishers).
  app.get('/orgs/:orgId/disputes', { preHandler: requireOrg('org:read', { allowSuspended: true }), schema: { tags: ['billing'], params: orgParams } }, async (req) => {
    const rows = (await db.query(`SELECT id, subject_type, subject_id, body, status, resolution, created_at, updated_at FROM disputes WHERE org_id = $1 ORDER BY created_at DESC`, [req.org!.id])).rows;
    return { data: rows };
  });

  app.post('/orgs/:orgId/disputes', { config: mgmt, preHandler: requireOrg('org:update', { allowSuspended: true }), schema: { tags: ['billing'], params: orgParams, body: disputeBody } }, async (req, reply) => {
    const user = requireUser(req);
    const b = bodyOf(req, disputeBody);
    const row = (await db.query(`INSERT INTO disputes (org_id, subject_type, subject_id, body, opened_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [req.org!.id, b.subjectType, b.subjectId ?? null, b.body, user.id])).rows[0];
    await audit(db, req, { action: 'dispute.open', resourceType: 'dispute', resourceId: row.id, orgId: req.org!.id });
    return reply.status(201).send({ data: row });
  });

  // Development-only simulated checkout completion. Goes through the signed webhook path.
  app.post('/payments/dev/:id/complete', { config: mgmt, schema: { tags: ['billing'], params: idParams, body: z.object({ outcome: z.enum(['succeeded', 'failed']) }), hide: ctx.config.isProd } }, async (req) => {
    const user = requireUser(req);
    const provider = ctx.payments.get('dev_simulated');
    if (!(provider instanceof DevSimulatedProvider)) throw notFound();
    const { id } = paramsOf(req, idParams);
    const p = (await db.query(`SELECT p.* FROM payments p JOIN memberships m ON m.org_id = p.org_id AND m.user_id = $2 WHERE p.id = $1 AND p.provider = 'dev_simulated'`, [id, user.id])).rows[0];
    if (!p) throw notFound();
    if (p.status !== 'pending') throw conflict('This payment is no longer pending');
    const body = JSON.stringify({ id: `devevt_${randomUUID()}`, paymentId: p.id, outcome: (req.body as { outcome: string }).outcome, amountMicros: p.amount_micros, currency: p.currency });
    const res = await handlePaymentWebhook(ctx, 'dev_simulated', Buffer.from(body), { 'x-dev-signature': provider.sign(body) });
    return { ok: res.status === 200, simulated: true };
  });
}

/** Payment webhooks need the exact raw body for signature verification, so they live in their own encapsulated context. */
export async function webhookRoutes(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 512_000 }, (_req, body, done) => done(null, body));
  app.post('/webhooks/payments/:provider', { config: { rateLimit: { bucket: 'webhook', limit: 600 }, csrfExempt: true, allowDuringMaintenance: true }, schema: { tags: ['webhooks'], params: z.object({ provider: z.string().regex(/^[a-z_]{2,40}$/) }) } }, async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const res = await handlePaymentWebhook(app.ctx, provider, raw, req.headers as Record<string, string>);
    return reply.status(res.status).send(res.body);
  });
}
