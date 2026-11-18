import { createHmac, timingSafeEqual } from 'node:crypto';
import { MICROS_PER_MINOR } from '@blissnova/shared';
import type { CaptureResult, CheckoutRequest, CheckoutResult, PaymentProvider, ProviderStatus, WebhookVerification } from './types';

/** Currencies a Paystack business can be enabled for. Which ones work depends on the account (USD needs approval). */
export const PAYSTACK_CURRENCIES = new Set(['NGN', 'USD', 'GHS', 'ZAR', 'KES']);

type PaystackTx = { id?: number; reference?: string; status?: string; amount?: number; currency?: string; gateway_response?: string; metadata?: unknown };

/**
 * Paystack Checkout (card, bank transfer, USSD). Paystack serves businesses
 * registered in Nigeria, Ghana, Kenya and South Africa, where Stripe does not
 * onboard businesses directly. Uses the REST API directly (no SDK).
 *
 * As with every provider, nothing is credited from the browser: only from a
 * verified webhook (HMAC-SHA512 of the raw body with the secret key) or from
 * Paystack's own Verify Transaction answer, and only when the amount and
 * currency match our record.
 */
export class PaystackProvider implements PaymentProvider {
  readonly id = 'paystack';
  readonly label = 'Card (Paystack)';
  private readonly apiBase: string;
  private readonly currencies: Set<string>;

  constructor(private secretKey: string | undefined, currencies: string[] = ['NGN', 'USD'], private fetchImpl: typeof fetch = fetch, apiBase = 'https://api.paystack.co') {
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.currencies = new Set(currencies.map((c) => c.trim().toUpperCase()).filter((c) => PAYSTACK_CURRENCIES.has(c)));
  }

  get mode(): 'live' | 'test' {
    return this.secretKey?.startsWith('sk_live_') ? 'live' : 'test';
  }

  status(): ProviderStatus {
    const configured = Boolean(this.secretKey);
    return {
      id: this.id, label: this.label, configured, supportsCheckout: true, supportsWebhooks: true, supportsRefunds: true, mode: this.mode,
      detail: !configured ? 'Set PAYSTACK_SECRET_KEY.' : this.mode === 'test' ? 'Test mode: use Paystack test cards, no real money moves.' : 'Live mode. Run a connection test before taking payments.',
    };
  }

  supportsCurrency(currency: string) {
    return this.currencies.has(currency.toUpperCase());
  }

  /** Paystack amounts are in the currency's subunit (kobo, cents, pesewas). All supported currencies have two decimals. */
  private toMinor(micros: bigint): bigint {
    if (micros % MICROS_PER_MINOR !== 0n) throw new Error('Amount must be a whole number of minor units');
    return micros / MICROS_PER_MINOR;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.secretKey) throw new Error('Paystack is not configured');
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.secretKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
    if (!res.ok || json.status !== true) throw new Error(`Paystack ${path.split('?')[0]} failed: ${json.message ?? res.status}`);
    return json.data as T;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    if (!req.customerEmail) throw new Error('Paystack needs the payer’s email address');
    // Our payment id is the Paystack reference, so a retried call cannot create a second transaction.
    const data = await this.call<{ authorization_url?: string; reference?: string }>('POST', '/transaction/initialize', {
      email: req.customerEmail,
      amount: this.toMinor(req.amountMicros).toString(),
      currency: req.currency,
      reference: req.paymentId,
      callback_url: req.successUrl,
      metadata: { payment_id: req.paymentId, org_id: req.orgId, cancel_action: req.cancelUrl, custom_fields: [{ display_name: 'Description', variable_name: 'description', value: req.description }] },
    });
    if (!data?.authorization_url) throw new Error('Paystack did not return a checkout link');
    return { providerRef: data.reference ?? req.paymentId, checkoutUrl: data.authorization_url };
  }

  private fromTx(tx: PaystackTx | undefined): CaptureResult {
    const currency = typeof tx?.currency === 'string' ? tx.currency.toUpperCase() : null;
    const amountMicros = typeof tx?.amount === 'number' ? BigInt(tx.amount) * MICROS_PER_MINOR : null;
    const chargeRef = tx?.id !== undefined ? String(tx.id) : null;
    if (tx?.status === 'success') return { outcome: 'succeeded', amountMicros, currency, chargeRef };
    // 'abandoned' is also what Paystack reports before the buyer has paid, so it stays pending.
    if (tx?.status === 'failed' || tx?.status === 'reversed') return { outcome: 'failed', amountMicros, currency, chargeRef, failureReason: tx.gateway_response ?? `Transaction ${tx.status}` };
    return { outcome: 'pending', amountMicros, currency, chargeRef };
  }

  /** Called when the advertiser returns, and by the reconciliation job: asks Paystack for the transaction's real status. */
  async capture(payment: { id: string; provider_ref: string | null }): Promise<CaptureResult> {
    const ref = payment.provider_ref ?? payment.id;
    try {
      return this.fromTx(await this.call<PaystackTx>('GET', `/transaction/verify/${encodeURIComponent(ref)}`));
    } catch (err) {
      // Not paid yet (the buyer is still on the checkout page, or left).
      if (/not found|no transaction/i.test((err as Error).message)) return { outcome: 'pending', amountMicros: null, currency: null, chargeRef: null };
      throw err;
    }
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookVerification {
    if (!this.secretKey) return { ok: false, reason: 'Paystack is not configured' };
    const sig = headers['x-paystack-signature'];
    if (typeof sig !== 'string' || !/^[0-9a-f]{128}$/i.test(sig)) return { ok: false, reason: 'Missing or malformed x-paystack-signature header' };
    const expected = createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    if (!timingSafeEqual(Buffer.from(sig.toLowerCase()), Buffer.from(expected))) return { ok: false, reason: 'Signature mismatch' };
    let evt: { event?: string; data?: Record<string, any> };
    try {
      evt = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { ok: false, reason: 'Invalid JSON' };
    }
    const type = String(evt.event ?? '');
    const d = evt.data ?? {};
    // Paystack events carry no event id; the event name plus the object's own id is unique per delivery subject.
    const eventId = `${type}:${d.id ?? d.reference ?? ''}`;
    if (type === 'charge.dispute.create') {
      const tx = (d.transaction ?? {}) as PaystackTx;
      const currency = typeof d.currency === 'string' ? d.currency.toUpperCase() : typeof tx.currency === 'string' ? tx.currency.toUpperCase() : null;
      const minor = typeof d.refund_amount === 'number' ? d.refund_amount : typeof tx.amount === 'number' ? tx.amount : null;
      return { ok: true, raw: evt, event: { eventId, type, paymentId: null, providerRef: null, outcome: 'disputed', amountMicros: minor !== null ? BigInt(minor) * MICROS_PER_MINOR : null, currency, chargeRef: tx.id !== undefined ? String(tx.id) : null, dispute: { id: String(d.id ?? ''), reason: typeof d.category === 'string' ? d.category : null } } };
    }
    if (type !== 'charge.success') return { ok: true, raw: evt, event: { eventId, type, paymentId: null, providerRef: null, outcome: 'ignored', amountMicros: null, currency: null } };
    const r = this.fromTx(d as PaystackTx);
    const reference = typeof d.reference === 'string' ? d.reference : null;
    return { ok: true, raw: evt, event: { eventId, type, paymentId: reference, providerRef: reference, outcome: r.outcome === 'succeeded' ? 'succeeded' : 'ignored', amountMicros: r.amountMicros, currency: r.currency, chargeRef: r.chargeRef } };
  }

  async refund(payment: { id: string; provider_charge_ref: string | null; currency: string }, amountMicros: bigint, _idempotencyKey: string) {
    // Paystack has no idempotency header; the finance route only calls this once per refund key.
    const data = await this.call<{ id?: number; status?: string; transaction?: { id?: number } }>('POST', '/refund', {
      transaction: payment.provider_charge_ref ?? payment.id,
      amount: this.toMinor(amountMicros).toString(),
      currency: payment.currency,
      merchant_note: `Refund of BlissNova payment ${payment.id}`,
    });
    if (data?.status === 'failed') throw new Error('Paystack refund failed');
    return { providerRef: String(data?.id ?? `paystack-refund-${payment.id}`) };
  }

  async testConnection() {
    if (!this.secretKey) return { ok: false, detail: 'PAYSTACK_SECRET_KEY is not set' };
    try {
      await this.call('GET', '/balance');
      return { ok: true, detail: 'Authenticated request to Paystack succeeded' };
    } catch (err) {
      return { ok: false, detail: `Paystack: ${(err as Error).message}` };
    }
  }
}
