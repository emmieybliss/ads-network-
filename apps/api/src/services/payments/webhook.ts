import { confirmPayment, failPayment } from '@blissnova/billing';
import { formatMoney } from '@blissnova/shared';
import type { AppContext } from '../../lib/context';
import { tx } from '../../lib/tx';
import { notifyOrg } from '../notifications';

type Q = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

/**
 * Credit a payment the provider has confirmed (verified webhook, or a capture
 * response from the provider's own API). The amount and currency must match
 * our record exactly. Idempotent: crediting twice is a no-op.
 */
export async function creditPayment(ctx: AppContext, payment: { id: string; org_id: string; amount_micros: string; currency: string }, providerId: string, e: { amountMicros: bigint | null; currency: string | null; providerRef: string | null; chargeRef: string | null; eventId?: string }, inTx?: (c: Q) => Promise<void>) {
  if (e.amountMicros === null || e.amountMicros !== BigInt(payment.amount_micros) || (e.currency && e.currency !== payment.currency)) {
    throw new Error(`Amount or currency mismatch (provider ${e.amountMicros} ${e.currency}, expected ${payment.amount_micros} ${payment.currency})`);
  }
  const s = await ctx.settings.get();
  const res = await tx(ctx, async (c) => {
    const r = await confirmPayment(c, { paymentId: payment.id, actor: { type: 'provider', provider: providerId }, feeBps: s.pricing.advertiserFeeBps, providerRef: e.providerRef ?? undefined, invoicePrefix: s.pricing.invoicePrefix });
    if (e.chargeRef) await c.query('UPDATE payments SET provider_charge_ref = $2 WHERE id = $1 AND provider_charge_ref IS NULL', [payment.id, e.chargeRef]);
    if (inTx) await inTx(c);
    if (r.created) await c.query(`INSERT INTO audit_logs (actor_type, org_id, action, resource_type, resource_id, after) VALUES ('provider', $1, 'payment.confirmed', 'payment', $2, $3)`, [payment.org_id, payment.id, JSON.stringify({ provider: providerId, eventId: e.eventId ?? null })]);
    return r;
  });
  if (res.created) await notifyOrg(ctx, payment.org_id, { type: 'payment_confirmed', title: 'Payment received', link: '/advertiser/billing', template: 'payment_confirmed', vars: { amount: formatMoney(payment.amount_micros, payment.currency) }, roles: ['owner'] }).catch(() => undefined);
  return res;
}

/**
 * Complete a provider checkout that needs a server-side capture (PayPal),
 * using the provider API's own answer. Safe to call repeatedly.
 */
export async function capturePayment(ctx: AppContext, payment: { id: string; org_id: string; provider: string; provider_ref: string | null; amount_micros: string; currency: string; status: string }) {
  const provider = ctx.payments.get(payment.provider);
  if (!provider?.capture || payment.status !== 'pending') return { status: payment.status };
  const r = await provider.capture(payment);
  if (r.outcome === 'succeeded') {
    await creditPayment(ctx, payment, provider.id, { amountMicros: r.amountMicros, currency: r.currency, providerRef: payment.provider_ref, chargeRef: r.chargeRef });
    return { status: 'succeeded' };
  }
  if (r.outcome === 'failed') {
    await failPayment(ctx.db as never, payment.id, r.failureReason ?? 'Provider reported the payment failed');
    return { status: 'failed' };
  }
  return { status: 'pending' };
}

/** Fallback for buyers who approve but never come back: capture recent pending PayPal orders. */
export async function syncPendingCaptures(ctx: AppContext) {
  const ids = ctx.payments.list().filter((p) => p.capture).map((p) => p.id);
  if (!ids.length) return { checked: 0 };
  const rows = (await ctx.db.query(`SELECT * FROM payments WHERE status = 'pending' AND provider = ANY($1) AND created_at < now() - interval '2 minutes' AND created_at > now() - interval '3 days' ORDER BY created_at LIMIT 50`, [ids])).rows;
  for (const p of rows) await capturePayment(ctx, p).catch((err) => ctx.log.warn({ err: (err as Error).message, payment: p.id }, 'payment capture sync failed'));
  return { checked: rows.length };
}

export type WebhookResult = { status: 200 | 400 | 404; body: Record<string, unknown> };

/**
 * Verified, idempotent webhook processing. Each provider event id is stored
 * once; replays are acknowledged without side effects. A payment is credited
 * only if the provider-reported amount and currency match our record.
 */
export async function handlePaymentWebhook(ctx: AppContext, providerId: string, raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<WebhookResult> {
  const provider = ctx.payments.get(providerId);
  if (!provider) return { status: 404, body: { error: 'unknown provider' } };
  const v = await provider.verifyWebhook(raw, headers);
  if (!v.ok) {
    await ctx.db.query(`INSERT INTO security_events (type, severity, subject, detail) VALUES ('webhook_signature_invalid', 'warning', $1, $2)`, [providerId, JSON.stringify({ reason: v.reason })]);
    return { status: 400, body: { error: 'invalid signature' } };
  }
  const e = v.event;
  const ins = await ctx.db.query(
    `INSERT INTO payment_webhook_events (provider, provider_event_id, type, signature_valid, payload) VALUES ($1, $2, $3, true, $4)
     ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`, [providerId, e.eventId, e.type, JSON.stringify(v.raw)]);
  let eventRowId = ins.rows[0]?.id as string | undefined;
  if (!eventRowId) {
    const prior = (await ctx.db.query(`SELECT id, processed_at FROM payment_webhook_events WHERE provider = $1 AND provider_event_id = $2`, [providerId, e.eventId])).rows[0];
    if (prior?.processed_at) return { status: 200, body: { received: true, duplicate: true } };
    eventRowId = prior?.id;
  }
  try {
    if (e.outcome === 'ignored') {
      await ctx.db.query('UPDATE payment_webhook_events SET processed_at = now() WHERE id = $1', [eventRowId]);
      return { status: 200, body: { received: true, ignored: true } };
    }
    const payment = (await ctx.db.query(`SELECT * FROM payments WHERE provider = $1 AND (id::text = $2 OR provider_ref = $3)`, [providerId, e.paymentId ?? '', e.providerRef ?? ''])).rows[0];
    if (!payment) throw new Error('No matching payment for webhook event');
    if (e.outcome === 'succeeded') {
      await creditPayment(ctx, payment, providerId, { amountMicros: e.amountMicros, currency: e.currency, providerRef: e.providerRef, chargeRef: e.chargeRef ?? null, eventId: e.eventId }, async (c) => {
        await c.query('UPDATE payment_webhook_events SET processed_at = now(), processing_error = NULL WHERE id = $1', [eventRowId]);
      });
    } else {
      await failPayment(ctx.db as never, payment.id, e.failureReason ?? e.type);
      await ctx.db.query('UPDATE payment_webhook_events SET processed_at = now() WHERE id = $1', [eventRowId]);
    }
    return { status: 200, body: { received: true } };
  } catch (err) {
    await ctx.db.query('UPDATE payment_webhook_events SET processing_error = $2 WHERE id = $1', [eventRowId, (err as Error).message.slice(0, 500)]);
    ctx.log.error({ err, provider: providerId, eventId: e.eventId }, 'webhook processing failed');
    // 200 for permanent data problems (logged for finance review) avoids endless provider retries; signature failures above return 400.
    return { status: 200, body: { received: true, processed: false } };
  }
}
