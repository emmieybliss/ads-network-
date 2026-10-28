import type { AppConfig } from '../../config';
import type { PayPalClient } from '../paypal';
import { DevSimulatedPayoutProvider } from './dev';
import { PayPalPayoutProvider } from './paypal';
import type { PayoutProvider } from './types';

/** Bank and crypto payouts with no provider are sent by finance staff and recorded with their reference. */
export class PayoutProviderRegistry {
  private providers = new Map<string, PayoutProvider>();
  constructor(cfg: AppConfig, paypal: PayPalClient) {
    if (paypal.configured) this.register(new PayPalPayoutProvider(paypal));
    if (cfg.ENABLE_DEV_PAYMENTS && !cfg.isProd) this.register(new DevSimulatedPayoutProvider(cfg.APP_SECRET));
  }
  register(p: PayoutProvider) {
    this.providers.set(p.id, p);
  }
  get(id: string): PayoutProvider | undefined {
    return this.providers.get(id);
  }
  list(): PayoutProvider[] {
    return [...this.providers.values()];
  }
}
