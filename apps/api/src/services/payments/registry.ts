import type { AppConfig } from '../../config';
import { PayPalClient } from '../paypal';
import { DevSimulatedProvider } from './dev';
import { ManualTransferProvider } from './manual';
import { PayPalCheckoutProvider } from './paypal';
import { StripeProvider } from './stripe';
import type { PaymentProvider } from './types';

export function paypalClientFor(cfg: AppConfig, fetchImpl?: typeof fetch) {
  return new PayPalClient({ clientId: cfg.PAYPAL_CLIENT_ID, clientSecret: cfg.PAYPAL_CLIENT_SECRET, webhookId: cfg.PAYPAL_WEBHOOK_ID, env: cfg.PAYPAL_ENV }, fetchImpl);
}

export class PaymentProviderRegistry {
  private providers = new Map<string, PaymentProvider>();
  constructor(cfg: AppConfig, paypal: PayPalClient = paypalClientFor(cfg)) {
    this.register(new ManualTransferProvider());
    const stripe = new StripeProvider(cfg.STRIPE_SECRET_KEY, cfg.STRIPE_WEBHOOK_SECRET);
    if (stripe.status().configured) this.register(stripe);
    if (paypal.configured) this.register(new PayPalCheckoutProvider(paypal));
    if (cfg.ENABLE_DEV_PAYMENTS && !cfg.isProd) this.register(new DevSimulatedProvider(cfg.APP_SECRET, cfg.PUBLIC_SITE_URL));
  }
  register(p: PaymentProvider) {
    this.providers.set(p.id, p);
  }
  get(id: string): PaymentProvider | undefined {
    return this.providers.get(id);
  }
  list(): PaymentProvider[] {
    return [...this.providers.values()];
  }
}
