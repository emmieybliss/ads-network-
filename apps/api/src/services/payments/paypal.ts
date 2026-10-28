import { PAYPAL_CURRENCIES, PayPalError, fromPayPalAmount, toPayPalAmount, type PayPalClient } from '../paypal';
import type { CaptureResult, CheckoutRequest, CheckoutResult, PaymentProvider, ProviderStatus, WebhookVerification } from './types';

/**
 * PayPal deposits through the Orders v2 API. The advertiser approves on
 * PayPal, then the order is captured server-side (when they return, by the
 * reconciliation job, or on webhook). Funds are credited only from a
 * COMPLETED capture whose amount matches the payment record.
 */
export class PayPalCheckoutProvider implements PaymentProvider {
  readonly id = 'paypal';
  readonly label = 'PayPal';
  constructor(private client: PayPalClient, private brandName = 'BlissNova') {}

  status(): ProviderStatus {
    return {
      id: this.id, label: this.label, configured: this.client.configured, supportsCheckout: true, supportsWebhooks: true, supportsRefunds: true, mode: this.client.env === 'live' ? 'live' : 'test',
      detail: !this.client.configured ? 'Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID.' : this.client.env === 'live' ? 'Live PayPal account.' : 'Sandbox: use PayPal sandbox buyer accounts, no real money moves.',
    };
  }

  supportsCurrency(currency: string) {
    return PAYPAL_CURRENCIES.has(currency);
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const order = await this.client.request<{ id: string; links?: Array<{ rel: string; href: string }> }>('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: req.paymentId, custom_id: req.paymentId, description: req.description.slice(0, 127), amount: { currency_code: req.currency, value: toPayPalAmount(req.amountMicros) } }],
      payment_source: { paypal: { experience_context: { brand_name: this.brandName.slice(0, 127), user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: req.successUrl, cancel_url: req.cancelUrl } } },
    }, `checkout-${req.paymentId}`);
    const approve = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href ?? null;
    if (!approve) throw new Error('PayPal did not return an approval link');
    return { providerRef: order.id, checkoutUrl: approve };
  }

  private fromOrder(order: any): CaptureResult {
    const cap = order?.purchase_units?.[0]?.payments?.captures?.[0];
    if (!cap) return { outcome: order?.status === 'VOIDED' ? 'failed' : 'pending', amountMicros: null, currency: null, chargeRef: null, failureReason: order?.status === 'VOIDED' ? 'Order voided' : undefined };
    const outcome = cap.status === 'COMPLETED' ? 'succeeded' : cap.status === 'PENDING' ? 'pending' : 'failed';
    return { outcome, amountMicros: cap.amount?.value ? fromPayPalAmount(cap.amount.value) : null, currency: cap.amount?.currency_code ?? null, chargeRef: cap.id ?? null, failureReason: outcome === 'failed' ? `Capture ${cap.status}` : undefined };
  }

  async capture(payment: { id: string; provider_ref: string | null }): Promise<CaptureResult> {
    if (!payment.provider_ref) throw new Error('Payment has no PayPal order');
    try {
      return this.fromOrder(await this.client.request('POST', `/v2/checkout/orders/${encodeURIComponent(payment.provider_ref)}/capture`, {}, `capture-${payment.id}`));
    } catch (err) {
      // Already captured (for example by the webhook or a second tab): read the order instead.
      if (err instanceof PayPalError && err.issue === 'ORDER_ALREADY_CAPTURED') return this.fromOrder(await this.client.request('GET', `/v2/checkout/orders/${encodeURIComponent(payment.provider_ref)}`));
      // Buyer has not approved yet: nothing to capture.
      if (err instanceof PayPalError && err.issue === 'ORDER_NOT_APPROVED') return { outcome: 'pending', amountMicros: null, currency: null, chargeRef: null };
      throw err;
    }
  }

  async verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<WebhookVerification> {
    const v = await this.client.verifyWebhook(rawBody, headers);
    if (!v.ok) return v;
    const e = v.event;
    const r = e.resource ?? {};
    let outcome: 'succeeded' | 'failed' | 'ignored' = 'ignored';
    if (e.event_type === 'PAYMENT.CAPTURE.COMPLETED') outcome = 'succeeded';
    else if (e.event_type === 'PAYMENT.CAPTURE.DENIED' || e.event_type === 'PAYMENT.CAPTURE.DECLINED') outcome = 'failed';
    const orderId = r.supplementary_data?.related_ids?.order_id ?? null;
    return {
      ok: true, raw: e,
      event: {
        eventId: e.id, type: e.event_type, paymentId: r.custom_id ?? null, providerRef: orderId, outcome, chargeRef: r.id ?? null,
        amountMicros: r.amount?.value ? fromPayPalAmount(r.amount.value) : null, currency: r.amount?.currency_code ?? null, failureReason: outcome === 'failed' ? e.event_type : undefined,
      },
    };
  }

  async refund(payment: { id: string; provider_charge_ref: string | null; currency: string }, amountMicros: bigint, idempotencyKey: string) {
    if (!payment.provider_charge_ref) throw new Error('This payment has no PayPal capture on record, so it cannot be refunded through PayPal');
    const r = await this.client.request<{ id: string; status: string }>('POST', `/v2/payments/captures/${encodeURIComponent(payment.provider_charge_ref)}/refund`, { amount: { currency_code: payment.currency, value: toPayPalAmount(amountMicros) } }, `refund-${idempotencyKey}`);
    if (r.status === 'FAILED' || r.status === 'CANCELLED') throw new Error(`PayPal refund ${r.status.toLowerCase()}`);
    return { providerRef: r.id };
  }

  testConnection() {
    return this.client.testConnection();
  }
}
