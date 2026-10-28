import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PayoutProvider, PayoutProviderStatus, PayoutSendRequest, PayoutSendResult, PayoutWebhookVerification } from './types';

/**
 * DEVELOPMENT ONLY. Pretends to send a payout by any method so the whole
 * flow can be tried locally. Completion still arrives as a signed webhook
 * through the same path a real provider uses. Never registered in production.
 */
export class DevSimulatedPayoutProvider implements PayoutProvider {
  readonly id = 'dev_simulated';
  readonly label = 'Development simulated payouts (no real money)';
  readonly methods = ['paypal', 'bank_transfer', 'crypto'] as const;
  constructor(private secret: string) {}

  status(): PayoutProviderStatus {
    return { id: this.id, label: this.label, configured: true, methods: [...this.methods], mode: 'simulated', supportsWebhooks: true, detail: 'Development only. Never enabled in production.' };
  }

  async send(req: PayoutSendRequest): Promise<PayoutSendResult> {
    return { providerRef: `devpayout_${req.payoutId}`, outcome: 'processing' };
  }

  sign(body: string) {
    return createHmac('sha256', `${this.secret}:dev-payouts`).update(body).digest('hex');
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PayoutWebhookVerification {
    const sig = headers['x-dev-signature'];
    if (typeof sig !== 'string') return { ok: false, reason: 'Missing signature' };
    const expected = this.sign(rawBody.toString('utf8'));
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return { ok: false, reason: 'Signature mismatch' };
    const evt = JSON.parse(rawBody.toString('utf8')) as { id: string; payoutId: string; outcome: 'paid' | 'failed'; reason?: string };
    return { ok: true, raw: evt, event: { eventId: evt.id, type: `dev.${evt.outcome}`, payoutId: evt.payoutId, providerRef: `devpayout_${evt.payoutId}`, outcome: evt.outcome, reason: evt.reason, reference: evt.outcome === 'paid' ? `SIM-${evt.payoutId.slice(0, 8).toUpperCase()}` : undefined } };
  }

  async testConnection() {
    return { ok: true, detail: 'Simulated provider' };
  }
}
