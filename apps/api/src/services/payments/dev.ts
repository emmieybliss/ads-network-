import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CheckoutRequest, CheckoutResult, PaymentProvider, ProviderStatus, WebhookVerification } from './types';

/**
 * DEVELOPMENT ONLY. Simulates a hosted checkout so the full funding flow can
 * be exercised locally. It still goes through a signed webhook and the same
 * idempotent crediting path. It refuses to load in production (see config).
 */
export class DevSimulatedProvider implements PaymentProvider {
  readonly id = 'dev_simulated';
  readonly label = 'Development simulated payments (no real money)';
  constructor(private secret: string, private siteUrl: string) {}
  status(): ProviderStatus {
    return { id: this.id, label: this.label, configured: true, supportsCheckout: true, supportsWebhooks: true, detail: 'Development only. Never enabled in production.' };
  }
  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    return { providerRef: `devpay_${req.paymentId}`, checkoutUrl: `${this.siteUrl}/dev/checkout/${req.paymentId}` };
  }
  sign(body: string) {
    return createHmac('sha256', `${this.secret}:dev-payments`).update(body).digest('hex');
  }
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookVerification {
    const sig = headers['x-dev-signature'];
    if (typeof sig !== 'string') return { ok: false, reason: 'Missing signature' };
    const expected = this.sign(rawBody.toString('utf8'));
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return { ok: false, reason: 'Signature mismatch' };
    const evt = JSON.parse(rawBody.toString('utf8')) as { id: string; paymentId: string; outcome: 'succeeded' | 'failed'; amountMicros: string; currency: string };
    return { ok: true, raw: evt, event: { eventId: evt.id, type: `dev.${evt.outcome}`, paymentId: evt.paymentId, providerRef: `devpay_${evt.paymentId}`, outcome: evt.outcome, amountMicros: BigInt(evt.amountMicros), currency: evt.currency } };
  }
  async testConnection() {
    return { ok: true, detail: 'Simulated provider' };
  }
}
