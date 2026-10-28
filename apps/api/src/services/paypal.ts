import { formatMicros, toMicros } from '@blissnova/shared';

/**
 * Minimal PayPal REST client (no SDK): OAuth client-credentials tokens,
 * idempotent requests, and webhook verification through PayPal's
 * verify-webhook-signature API. Shared by PayPal deposits (Orders API) and
 * PayPal payouts (Payouts API). Live use needs a PayPal business account.
 */
export const PAYPAL_BASE = { sandbox: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com' } as const;

/** Currencies PayPal accepts for both checkout and payouts (subset relevant to this platform). */
export const PAYPAL_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD']);

export interface PayPalConfig { clientId?: string; clientSecret?: string; webhookId?: string; env: 'sandbox' | 'live' }

export class PayPalError extends Error {
  constructor(message: string, public status: number, public issue?: string) {
    super(message);
  }
}

export interface PayPalWebhookEvent { id: string; event_type: string; resource: Record<string, any> }

export class PayPalClient {
  private token: { value: string; expires: number } | null = null;
  constructor(private cfg: PayPalConfig, private fetchImpl: typeof fetch = fetch) {}

  get configured() {
    return Boolean(this.cfg.clientId && this.cfg.clientSecret && this.cfg.webhookId);
  }

  get env() {
    return this.cfg.env;
  }

  private get base() {
    return PAYPAL_BASE[this.cfg.env];
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    if (!this.cfg.clientId || !this.cfg.clientSecret) throw new PayPalError('PayPal is not configured', 0);
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) throw new PayPalError(`PayPal sign-in failed: ${body.error_description ?? res.status}`, res.status);
    this.token = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  async request<T = any>(method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    const res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const issue = json?.details?.[0]?.issue ?? json?.name;
      throw new PayPalError(`PayPal ${method} ${path.split('?')[0]} failed: ${json?.details?.[0]?.description ?? json?.message ?? res.status}`, res.status, issue);
    }
    return json as T;
  }

  /**
   * Ask PayPal whether a webhook delivery is genuine. PayPal signs with a
   * certificate chain, so verification is delegated to PayPal itself rather
   * than reimplemented here.
   */
  async verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ ok: true; event: PayPalWebhookEvent } | { ok: false; reason: string }> {
    if (!this.configured) return { ok: false, reason: 'PayPal is not configured' };
    const h = (k: string) => (typeof headers[k] === 'string' ? (headers[k] as string) : '');
    if (!h('paypal-transmission-id') || !h('paypal-transmission-sig')) return { ok: false, reason: 'Missing PayPal signature headers' };
    let event: PayPalWebhookEvent;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { ok: false, reason: 'Invalid JSON' };
    }
    try {
      const r = await this.request<{ verification_status?: string }>('POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: h('paypal-auth-algo'), cert_url: h('paypal-cert-url'), transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'), transmission_time: h('paypal-transmission-time'), webhook_id: this.cfg.webhookId, webhook_event: event,
      });
      return r.verification_status === 'SUCCESS' ? { ok: true, event } : { ok: false, reason: 'PayPal rejected the signature' };
    } catch (err) {
      return { ok: false, reason: `Could not verify with PayPal: ${(err as Error).message}` };
    }
  }

  async testConnection(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.accessToken();
      return { ok: true, detail: `Signed in to PayPal (${this.cfg.env})` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}

/** PayPal amounts are decimal strings with two places for the currencies we use. */
export const toPayPalAmount = (micros: bigint) => formatMicros(micros, 2);
export const fromPayPalAmount = (value: string) => toMicros(value);
