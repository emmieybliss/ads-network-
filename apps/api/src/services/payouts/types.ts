import type { PayoutDetails, PayoutMethod } from '@blissnova/shared';

export interface PayoutSendRequest { payoutId: string; orgId: string; amountMicros: bigint; currency: string; destination: PayoutDetails; note: string }
export interface PayoutSendResult { providerRef: string; outcome: 'processing' | 'paid' | 'failed'; failureReason?: string }
export interface PayoutStatusResult { outcome: 'processing' | 'paid' | 'failed'; detail?: string; reference?: string }

export interface NormalizedPayoutEvent {
  eventId: string;
  type: string;
  /** Our payout id when the provider echoes it back. */
  payoutId: string | null;
  providerRef: string | null;
  outcome: 'paid' | 'failed' | 'ignored';
  reason?: string;
  /** The provider's transaction id for the transfer, shown to the publisher. */
  reference?: string;
}

export type PayoutWebhookVerification = { ok: true; event: NormalizedPayoutEvent; raw: unknown } | { ok: false; reason: string };

export interface PayoutProviderStatus { id: string; label: string; configured: boolean; methods: PayoutMethod[]; mode: 'test' | 'live' | 'simulated'; supportsWebhooks: boolean; detail: string }

/**
 * Sends approved payouts. Providers never move ledger balances themselves:
 * the payout service records processing / paid / failed through the
 * idempotent billing operations, from provider API responses or verified
 * webhooks only.
 */
export interface PayoutProvider {
  readonly id: string;
  readonly label: string;
  readonly methods: readonly PayoutMethod[];
  status(): PayoutProviderStatus;
  supportsCurrency?(currency: string): boolean;
  /** Must be idempotent per payoutId: a retry after a crash must not pay twice. */
  send(req: PayoutSendRequest): Promise<PayoutSendResult>;
  /** Poll the provider for a payout already sent (fallback when webhooks are missed). */
  fetchStatus?(providerRef: string): Promise<PayoutStatusResult>;
  verifyWebhook?(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PayoutWebhookVerification | Promise<PayoutWebhookVerification>;
  testConnection(): Promise<{ ok: boolean; detail: string }>;
}
