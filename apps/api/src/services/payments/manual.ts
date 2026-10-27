import type { CheckoutRequest, CheckoutResult, PaymentProvider, ProviderStatus, WebhookVerification } from './types';

/**
 * Bank transfer / invoice payments. The advertiser receives a unique
 * reference; finance staff confirm receipt manually (with step-up
 * authentication, a reason, and an audit record). No automatic credit.
 */
export class ManualTransferProvider implements PaymentProvider {
  readonly id = 'bank_transfer';
  readonly label = 'Bank transfer (manual confirmation)';
  status(): ProviderStatus {
    return { id: this.id, label: this.label, configured: true, supportsCheckout: false, supportsWebhooks: false, detail: 'Funds are credited only after finance staff confirm receipt.' };
  }
  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const ref = `BN-${req.paymentId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;
    return { providerRef: ref, checkoutUrl: null, instructions: `Transfer the exact amount using payment reference ${ref}. Bank details are provided by the BlissNova finance team on request. Funds appear in your balance after finance confirms receipt.` };
  }
  verifyWebhook(): WebhookVerification {
    return { ok: false, reason: 'Manual transfers do not use webhooks' };
  }
  async testConnection() {
    return { ok: true, detail: 'No external service; confirmation is manual.' };
  }
}
