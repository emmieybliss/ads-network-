export interface CheckoutRequest { paymentId: string; orgId: string; amountMicros: bigint; currency: string; successUrl: string; cancelUrl: string; description: string }
export interface CheckoutResult { providerRef: string | null; checkoutUrl: string | null; instructions?: string }

export interface NormalizedWebhookEvent {
  eventId: string;
  type: string;
  /** Our payment id when the provider echoes it back (metadata / client reference). */
  paymentId: string | null;
  providerRef: string | null;
  outcome: 'succeeded' | 'failed' | 'ignored';
  amountMicros: bigint | null;
  currency: string | null;
  failureReason?: string;
  /** The provider's charge id (Stripe PaymentIntent, PayPal capture), kept for refunds. */
  chargeRef?: string | null;
}

export interface CaptureResult { outcome: 'succeeded' | 'pending' | 'failed'; amountMicros: bigint | null; currency: string | null; chargeRef: string | null; failureReason?: string }

export type WebhookVerification = { ok: true; event: NormalizedWebhookEvent; raw: unknown } | { ok: false; reason: string };

export interface ProviderStatus { id: string; label: string; configured: boolean; supportsCheckout: boolean; supportsWebhooks: boolean; detail: string; supportsRefunds?: boolean; mode?: 'test' | 'live' | 'simulated' | 'manual' }

/**
 * Payment provider abstraction. Providers never credit accounts themselves:
 * they create checkouts and verify webhooks; crediting happens only in the
 * webhook handler (or a finance-staff confirmation for manual transfers)
 * through the idempotent ledger workflow.
 */
export interface PaymentProvider {
  readonly id: string;
  readonly label: string;
  status(): ProviderStatus;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookVerification | Promise<WebhookVerification>;
  /** Make a harmless authenticated API call to prove the credentials work. */
  testConnection(): Promise<{ ok: boolean; detail: string }>;
  /** Currencies the provider can charge in. Omitted = any. */
  supportsCurrency?(currency: string): boolean;
  /**
   * Providers whose checkout must be completed server-side after the buyer
   * approves (PayPal). The result comes straight from the provider's API.
   */
  capture?(payment: { id: string; provider_ref: string | null }): Promise<CaptureResult>;
  /** Send money back through the provider. Idempotent per key. */
  refund?(payment: { id: string; provider_charge_ref: string | null; currency: string }, amountMicros: bigint, idempotencyKey: string): Promise<{ providerRef: string }>;
}
