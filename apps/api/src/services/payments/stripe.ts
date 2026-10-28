import { createHmac, timingSafeEqual } from 'node:crypto';
import { MICROS_PER_MINOR } from '@blissnova/shared';
import type { CheckoutRequest, CheckoutResult, PaymentProvider, ProviderStatus, WebhookVerification } from './types';

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'PYG', 'UGX', 'XAF', 'XOF']);

/** Stripe Checkout integration using the REST API directly (no SDK dependency). Live verification requires real credentials. */
export class StripeProvider implements PaymentProvider {
  readonly id = 'stripe';
  readonly label = 'Card (Stripe)';
  constructor(private secretKey: string | undefined, private webhookSecret: string | undefined, private fetchImpl: typeof fetch = fetch) {}

  status(): ProviderStatus {
    const configured = Boolean(this.secretKey && this.webhookSecret);
    const mode = this.secretKey?.includes('_live_') ? 'live' : 'test';
    return {
      id: this.id, label: this.label, configured, supportsCheckout: true, supportsWebhooks: true, supportsRefunds: true, mode,
      detail: !configured ? 'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.' : mode === 'test' ? 'Test mode: use Stripe test cards, no real money moves.' : 'Live mode. Run a connection test before taking payments.',
    };
  }

  private toMinor(micros: bigint, currency: string): bigint {
    if (ZERO_DECIMAL.has(currency)) return micros / 1_000_000n;
    if (micros % MICROS_PER_MINOR !== 0n) throw new Error('Amount must be a whole number of minor units');
    return micros / MICROS_PER_MINOR;
  }

  private fromMinor(minor: number, currency: string): bigint {
    return ZERO_DECIMAL.has(currency.toUpperCase()) ? BigInt(minor) * 1_000_000n : BigInt(minor) * MICROS_PER_MINOR;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    if (!this.secretKey) throw new Error('Stripe is not configured');
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      client_reference_id: req.paymentId,
      'metadata[payment_id]': req.paymentId,
      'metadata[org_id]': req.orgId,
      'payment_intent_data[metadata][payment_id]': req.paymentId,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': req.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': this.toMinor(req.amountMicros, req.currency).toString(),
      'line_items[0][price_data][product_data][name]': req.description,
    });
    const res = await this.fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `checkout-${req.paymentId}` },
      body: form,
    });
    const body = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
    if (!res.ok || !body.id) throw new Error(`Stripe checkout failed: ${body.error?.message ?? res.status}`);
    return { providerRef: body.id, checkoutUrl: body.url ?? null };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, now = Date.now()): WebhookVerification {
    if (!this.webhookSecret) return { ok: false, reason: 'Webhook secret not configured' };
    const header = headers['stripe-signature'];
    if (typeof header !== 'string') return { ok: false, reason: 'Missing Stripe-Signature header' };
    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]).filter((p) => p.length === 2)) as Record<string, string>;
    const t = Number(parts.t);
    const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
    if (!t || sigs.length === 0) return { ok: false, reason: 'Malformed signature header' };
    if (Math.abs(now / 1000 - t) > 300) return { ok: false, reason: 'Signature timestamp outside tolerance' };
    const expected = createHmac('sha256', this.webhookSecret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
    const match = sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
    if (!match) return { ok: false, reason: 'Signature mismatch' };
    let evt: { id: string; type: string; data: { object: Record<string, unknown> } };
    try {
      evt = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { ok: false, reason: 'Invalid JSON' };
    }
    const obj = evt.data?.object ?? {};
    const metadata = (obj.metadata ?? {}) as Record<string, string>;
    const paymentId = (obj.client_reference_id as string) || metadata.payment_id || null;
    const currency = typeof obj.currency === 'string' ? obj.currency.toUpperCase() : null;
    const amount = typeof obj.amount_total === 'number' && currency ? this.fromMinor(obj.amount_total, currency) : null;
    let outcome: 'succeeded' | 'failed' | 'ignored' = 'ignored';
    if ((evt.type === 'checkout.session.completed' && obj.payment_status === 'paid') || evt.type === 'checkout.session.async_payment_succeeded') outcome = 'succeeded';
    else if (evt.type === 'checkout.session.async_payment_failed' || evt.type === 'checkout.session.expired') outcome = 'failed';
    const chargeRef = typeof obj.payment_intent === 'string' ? obj.payment_intent : null;
    return { ok: true, raw: evt, event: { eventId: evt.id, type: evt.type, paymentId, providerRef: (obj.id as string) ?? null, outcome, amountMicros: amount, currency, chargeRef, failureReason: outcome === 'failed' ? evt.type : undefined } };
  }

  async refund(payment: { id: string; provider_charge_ref: string | null; currency: string }, amountMicros: bigint, idempotencyKey: string) {
    if (!this.secretKey) throw new Error('Stripe is not configured');
    if (!payment.provider_charge_ref) throw new Error('This payment has no Stripe PaymentIntent on record, so it cannot be refunded through Stripe');
    const form = new URLSearchParams({ payment_intent: payment.provider_charge_ref, amount: this.toMinor(amountMicros, payment.currency).toString(), 'metadata[payment_id]': payment.id });
    const res = await this.fetchImpl('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `refund-${idempotencyKey}` },
      body: form,
    });
    const body = (await res.json()) as { id?: string; status?: string; error?: { message?: string } };
    if (!res.ok || !body.id) throw new Error(`Stripe refund failed: ${body.error?.message ?? res.status}`);
    if (body.status === 'failed' || body.status === 'canceled') throw new Error(`Stripe refund ${body.status}`);
    return { providerRef: body.id };
  }

  async testConnection() {
    if (!this.secretKey) return { ok: false, detail: 'STRIPE_SECRET_KEY is not set' };
    try {
      const res = await this.fetchImpl('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${this.secretKey}` } });
      return res.ok ? { ok: true, detail: 'Authenticated request to Stripe succeeded' } : { ok: false, detail: `Stripe responded ${res.status}` };
    } catch (err) {
      return { ok: false, detail: `Could not reach Stripe: ${(err as Error).message}` };
    }
  }
}
