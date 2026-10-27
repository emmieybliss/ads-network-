import type { AppConfig } from '../../config';
import { DevSimulatedProvider } from './dev';
import { ManualTransferProvider } from './manual';
import { StripeProvider } from './stripe';
import type { PaymentProvider } from './types';

export class PaymentProviderRegistry {
  private providers = new Map<string, PaymentProvider>();
  constructor(cfg: AppConfig) {
    this.register(new ManualTransferProvider());
    const stripe = new StripeProvider(cfg.STRIPE_SECRET_KEY, cfg.STRIPE_WEBHOOK_SECRET);
    if (stripe.status().configured) this.register(stripe);
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
