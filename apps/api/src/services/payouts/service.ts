import { BillingError, markPayoutFailed, markPayoutPaid, markPayoutProcessing, type Actor } from '@blissnova/billing';
import { withTransaction } from '@blissnova/database';
import { formatMoney, payoutDetailsSchema, type PayoutDetails } from '@blissnova/shared';
import type { AppContext } from '../../lib/context';
import { decryptSecret, encryptSecret } from '../../lib/crypto';
import type { PayoutWebhookVerification } from './types';

export type Notify = (orgId: string, n: { type: string; title: string; body?: string; link?: string; template?: string; vars?: Record<string, string | number | undefined>; roles?: string[] }) => Promise<void>;
export type PayoutCtx = Pick<AppContext, 'db' | 'config' | 'payouts' | 'log'> & { notify: Notify };

export class PayoutSendError extends Error {}

export function encryptDestination(key: string, d: PayoutDetails): string {
  return encryptSecret(key, JSON.stringify(d));
}

/** Decrypt and re-validate a stored destination. Returns null for legacy label-only profiles. */
export function decryptDestination(key: string, blob: string | null | undefined): PayoutDetails | null {
  if (!blob) return null;
  return payoutDetailsSchema.parse(JSON.parse(decryptSecret(key, blob)));
}

async function notifyPayout(ctx: PayoutCtx, p: { org_id: string; amount_micros: string; currency: string; status: string; review_reason?: string | null; failure_reason?: string | null }) {
  await ctx.notify(p.org_id, { type: 'payout_status', title: `Payout ${p.status}`, link: '/publisher/earnings', template: 'payout_status', vars: { status: p.status, amount: formatMoney(p.amount_micros, p.currency), reason: p.failure_reason ?? p.review_reason ?? '' }, roles: ['owner'] }).catch(() => undefined);
}

/**
 * Send an approved payout through a provider. The provider call happens
 * outside the database transaction but is idempotent per payout id, so a
 * retry after a crash cannot pay twice. A provider error leaves the payout
 * approved (funds stay reserved) with the error noted for staff.
 */
export async function sendPayout(ctx: PayoutCtx, payoutId: string, providerId: string, actor: Actor) {
  const provider = ctx.payouts.get(providerId);
  if (!provider || !provider.status().configured) throw new PayoutSendError('That payout provider is not available');
  const p = (await ctx.db.query('SELECT p.*, o.name AS org_name FROM payouts p JOIN organizations o ON o.id = p.org_id WHERE p.id = $1', [payoutId])).rows[0];
  if (!p) throw new BillingError('Payout not found', 'not_found');
  if (p.status !== 'approved') throw new BillingError(`Payout is ${p.status}; only approved payouts can be sent`, 'conflict');
  if (!provider.methods.includes(p.method)) throw new PayoutSendError(`${provider.label} cannot pay by ${String(p.method ?? 'this method').replace('_', ' ')}`);
  if (provider.supportsCurrency && !provider.supportsCurrency(p.currency)) throw new PayoutSendError(`${provider.label} does not support ${p.currency}`);
  const destination = decryptDestination(ctx.config.ENCRYPTION_KEY, p.destination_encrypted);
  if (!destination) throw new PayoutSendError('This payout has no stored destination. Pay it manually and record the reference.');
  let result;
  try {
    result = await provider.send({ payoutId: p.id, orgId: p.org_id, amountMicros: BigInt(p.amount_micros), currency: p.currency, destination, note: `Payout of your publisher earnings (reference ${p.id.slice(0, 8).toUpperCase()})` });
  } catch (err) {
    await ctx.db.query('UPDATE payouts SET failure_reason = $2, updated_at = now() WHERE id = $1 AND status = $3', [p.id, `Send attempt failed: ${(err as Error).message}`.slice(0, 500), 'approved']);
    throw new PayoutSendError((err as Error).message);
  }
  const row = await withTransaction(ctx.db, async (c) => {
    let r = await markPayoutProcessing(c, p.id, provider.id, result.providerRef);
    await c.query('UPDATE payouts SET failure_reason = NULL WHERE id = $1', [p.id]);
    if (result.outcome === 'paid') r = await markPayoutPaid(c, p.id, actor, result.providerRef, `Paid via ${provider.label}`);
    if (result.outcome === 'failed') r = await markPayoutFailed(c, p.id, actor, result.failureReason ?? `${provider.label} refused the payout`);
    return r;
  });
  if (row.status !== 'processing') await notifyPayout(ctx, row);
  return row;
}

/** Record a provider-reported outcome. Idempotent; a paid payout is never moved back here. */
export async function applyPayoutOutcome(ctx: PayoutCtx, providerId: string, o: { payoutId: string | null; providerRef: string | null; outcome: 'paid' | 'failed'; reason?: string; reference?: string }) {
  const p = (await ctx.db.query(`SELECT * FROM payouts WHERE provider = $1 AND (id::text = $2 OR provider_ref = $3)`, [providerId, o.payoutId ?? '', o.providerRef ?? ''])).rows[0];
  if (!p) throw new Error('No matching payout for provider event');
  if (p.status === o.outcome) return { payout: p, changed: false };
  if (p.status === 'paid' && o.outcome === 'failed') throw new Error(`Provider reported ${o.reason ?? 'a failure'} for a payout already recorded as paid; finance must review it`);
  const actor: Actor = { type: 'provider', provider: providerId };
  const row = await withTransaction(ctx.db, (c) => o.outcome === 'paid'
    ? markPayoutPaid(c, p.id, actor, o.reference ?? p.provider_ref ?? o.providerRef ?? '', `Paid via ${providerId}`)
    : markPayoutFailed(c, p.id, actor, o.reason ?? `${providerId} reported the payout failed`));
  await notifyPayout(ctx, row);
  return { payout: row, changed: true };
}

export type PayoutWebhookResult = { status: 200 | 400 | 404; body: Record<string, unknown> };

/** Verified, idempotent payout webhook processing (same rules as payment webhooks). */
export async function handlePayoutWebhook(ctx: PayoutCtx, providerId: string, raw: Buffer, headers: Record<string, string | string[] | undefined>, verified?: PayoutWebhookVerification): Promise<PayoutWebhookResult> {
  const provider = ctx.payouts.get(providerId);
  if (!provider?.verifyWebhook) return { status: 404, body: { error: 'unknown provider' } };
  const v = verified ?? (await provider.verifyWebhook(raw, headers));
  if (!v.ok) {
    await ctx.db.query(`INSERT INTO security_events (type, severity, subject, detail) VALUES ('webhook_signature_invalid', 'warning', $1, $2)`, [`payout:${providerId}`, JSON.stringify({ reason: v.reason })]);
    return { status: 400, body: { error: 'invalid signature' } };
  }
  const e = v.event;
  const ins = await ctx.db.query(
    `INSERT INTO payment_webhook_events (provider, provider_event_id, type, signature_valid, payload) VALUES ($1, $2, $3, true, $4)
     ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`, [providerId, e.eventId, e.type, JSON.stringify(v.raw)]);
  let rowId = ins.rows[0]?.id as string | undefined;
  if (!rowId) {
    const prior = (await ctx.db.query(`SELECT id, processed_at FROM payment_webhook_events WHERE provider = $1 AND provider_event_id = $2`, [providerId, e.eventId])).rows[0];
    if (prior?.processed_at) return { status: 200, body: { received: true, duplicate: true } };
    rowId = prior?.id;
  }
  try {
    if (e.outcome !== 'ignored') await applyPayoutOutcome(ctx, providerId, { payoutId: e.payoutId, providerRef: e.providerRef, outcome: e.outcome, reason: e.reason, reference: e.reference });
    await ctx.db.query('UPDATE payment_webhook_events SET processed_at = now(), processing_error = NULL WHERE id = $1', [rowId]);
    return { status: 200, body: { received: true } };
  } catch (err) {
    await ctx.db.query('UPDATE payment_webhook_events SET processing_error = $2 WHERE id = $1', [rowId, (err as Error).message.slice(0, 500)]);
    ctx.log.error({ err, provider: providerId, eventId: e.eventId }, 'payout webhook processing failed');
    return { status: 200, body: { received: true, processed: false } };
  }
}

/** Fallback for missed webhooks: ask providers about payouts that have been processing for a while. */
export async function syncProcessingPayouts(ctx: PayoutCtx, olderThanMinutes = 10) {
  const rows = (await ctx.db.query(`SELECT id, provider, provider_ref FROM payouts WHERE status = 'processing' AND provider_ref IS NOT NULL AND updated_at < now() - make_interval(mins => $1) ORDER BY updated_at LIMIT 100`, [olderThanMinutes])).rows;
  let changed = 0;
  for (const r of rows) {
    const provider = ctx.payouts.get(r.provider);
    if (!provider?.fetchStatus) continue;
    try {
      const s = await provider.fetchStatus(r.provider_ref);
      if (s.outcome === 'processing') {
        await ctx.db.query('UPDATE payouts SET updated_at = now() WHERE id = $1', [r.id]);
        continue;
      }
      if ((await applyPayoutOutcome(ctx, r.provider, { payoutId: r.id, providerRef: r.provider_ref, outcome: s.outcome, reason: s.detail, reference: s.reference })).changed) changed++;
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message, payout: r.id }, 'payout status sync failed');
    }
  }
  return { checked: rows.length, changed };
}

/**
 * AdSense-style monthly payouts: on the configured day, raise a payout
 * request for every approved publisher who opted in and whose available
 * balance reaches the minimum. Staff still review and approve each one.
 */
export async function raiseAutomaticPayouts(ctx: Pick<AppContext, 'db'> & { notify?: Notify }, settings: { autoPayoutDay: number; minimumPayoutMicros: string }, now = new Date(), request: (r: { orgId: string; amount: bigint; currency: string; userId: string; key: string }) => Promise<unknown>) {
  if (!settings.autoPayoutDay || now.getUTCDate() !== settings.autoPayoutDay) return { raised: 0 };
  const month = now.toISOString().slice(0, 7);
  const rows = (await ctx.db.query(
    `SELECT pp.org_id, o.currency, COALESCE(pp.updated_by, (SELECT m.user_id FROM memberships m WHERE m.org_id = o.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1)) AS user_id,
            COALESCE((SELECT -sum(e.amount_micros) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'publisher_available' AND a.org_id = o.id AND a.currency = o.currency), 0)::text AS available
       FROM payout_profiles pp JOIN organizations o ON o.id = pp.org_id
      WHERE pp.auto_payout AND o.type = 'publisher' AND o.status = 'approved'
        AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.org_id = o.id AND p.status IN ('requested', 'approved', 'processing'))`)).rows;
  let raised = 0;
  for (const r of rows) {
    // Whole cents only: providers cannot send fractions of a cent.
    const amount = (BigInt(r.available) / 10_000n) * 10_000n;
    if (!r.user_id || amount < BigInt(settings.minimumPayoutMicros) || amount <= 0n) continue;
    try {
      await request({ orgId: r.org_id, amount, currency: r.currency, userId: r.user_id, key: `${r.org_id}:auto:${month}` });
      raised++;
      await ctx.notify?.(r.org_id, { type: 'payout_status', title: 'Monthly payout requested', body: 'Your available balance was requested for payout automatically. Finance reviews it before paying.', link: '/publisher/earnings', roles: ['owner'] }).catch(() => undefined);
    } catch {
      // Balance moved or a request appeared meanwhile; next month will try again.
    }
  }
  return { raised };
}
