import { PAYPAL_CURRENCIES, toPayPalAmount, type PayPalClient } from '../paypal';
import type { PayoutProvider, PayoutProviderStatus, PayoutSendRequest, PayoutSendResult, PayoutStatusResult, PayoutWebhookVerification } from './types';

const FAILED = new Set(['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'DENIED', 'CANCELED']);

/** PayPal Payouts API: one batch per payout, sender_batch_id = our payout id. */
export class PayPalPayoutProvider implements PayoutProvider {
  readonly id = 'paypal';
  readonly label = 'PayPal Payouts';
  readonly methods = ['paypal'] as const;
  constructor(private client: PayPalClient) {}

  status(): PayoutProviderStatus {
    return {
      id: this.id, label: this.label, configured: this.client.configured, methods: [...this.methods], mode: this.client.env === 'live' ? 'live' : 'test', supportsWebhooks: true,
      detail: !this.client.configured ? 'Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID, and enable Payouts on the PayPal business account.' : this.client.env === 'live' ? 'Sends real money from your PayPal balance.' : 'Sandbox: payouts go to PayPal sandbox accounts.',
    };
  }

  supportsCurrency(currency: string) {
    return PAYPAL_CURRENCIES.has(currency);
  }

  async send(req: PayoutSendRequest): Promise<PayoutSendResult> {
    if (req.destination.method !== 'paypal') throw new Error('PayPal can only pay to a PayPal email');
    const r = await this.client.request<{ batch_header?: { payout_batch_id?: string; batch_status?: string } }>('POST', '/v1/payments/payouts', {
      sender_batch_header: { sender_batch_id: req.payoutId, email_subject: 'You have a payout', email_message: req.note.slice(0, 1000) },
      items: [{ recipient_type: 'EMAIL', receiver: req.destination.email, sender_item_id: req.payoutId, note: req.note.slice(0, 4000), amount: { value: toPayPalAmount(req.amountMicros), currency: req.currency } }],
    }, `payout-${req.payoutId}`);
    const ref = r.batch_header?.payout_batch_id;
    if (!ref) throw new Error('PayPal did not return a payout batch id');
    return { providerRef: ref, outcome: r.batch_header?.batch_status === 'DENIED' ? 'failed' : 'processing', failureReason: r.batch_header?.batch_status === 'DENIED' ? 'PayPal denied the payout batch' : undefined };
  }

  async fetchStatus(providerRef: string): Promise<PayoutStatusResult> {
    const r = await this.client.request<{ batch_header?: { batch_status?: string }; items?: Array<{ transaction_status?: string; transaction_id?: string; errors?: { message?: string; name?: string } }> }>('GET', `/v1/payments/payouts/${encodeURIComponent(providerRef)}`);
    const item = r.items?.[0];
    const st = item?.transaction_status ?? r.batch_header?.batch_status ?? 'PENDING';
    if (st === 'SUCCESS') return { outcome: 'paid', reference: item?.transaction_id };
    if (FAILED.has(st)) return { outcome: 'failed', detail: item?.errors?.message ?? `PayPal status ${st}` };
    return { outcome: 'processing', detail: st };
  }

  async verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<PayoutWebhookVerification> {
    const v = await this.client.verifyWebhook(rawBody, headers);
    if (!v.ok) return v;
    const e = v.event;
    const r = e.resource ?? {};
    const st = e.event_type.replace('PAYMENT.PAYOUTS-ITEM.', '');
    const outcome = st === 'SUCCEEDED' ? 'paid' : FAILED.has(st) ? 'failed' : 'ignored';
    return {
      ok: true, raw: e,
      event: { eventId: e.id, type: e.event_type, payoutId: r.payout_item?.sender_item_id ?? null, providerRef: r.payout_batch_id ?? null, outcome, reference: r.transaction_id, reason: outcome === 'failed' ? (r.errors?.message ?? `PayPal ${st.toLowerCase()}`) : undefined },
    };
  }

  testConnection() {
    return this.client.testConnection();
  }
}
