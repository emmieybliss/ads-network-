import { z } from 'zod';
import { DEFAULT_BRAND } from './brand';

/**
 * Platform settings managed from the admin control center. Every group is
 * enforced by backend services; the dashboard and ad tag read only the
 * public projection (see PUBLIC_SETTING_KEYS). Secrets (SMTP passwords,
 * provider keys) are NEVER stored here: they come from environment variables.
 */
export const settingsSchema = z.object({
  tracking: z.object({
    enabled: z.boolean().default(true),
    impressions: z.boolean().default(true),
    clicks: z.boolean().default(true),
    viewability: z.boolean().default(true),
    consentRequired: z.boolean().default(true),
    personalizedAllowed: z.boolean().default(false),
    dedupWindowSeconds: z.number().int().min(60).max(7 * 86400).default(86400),
    tokenTtlSeconds: z.number().int().min(60).max(86400).default(3600),
    rawEventRetentionDays: z.number().int().min(7).max(730).default(90),
    aggregateRetentionDays: z.number().int().min(365).max(3650).default(2555),
  }).prefault({}),
  ivt: z.object({
    scoreThreshold: z.number().int().min(1).max(100).default(60),
    maxRequestsPerMinutePerIp: z.number().int().min(10).max(10000).default(120),
    maxClicksPerVisitorPerHour: z.number().int().min(1).max(1000).default(10),
    minRenderToClickMs: z.number().int().min(0).max(10000).default(300),
    ctrAlertPercent: z.number().min(0.1).max(100).default(5),
    ctrAlertMinImpressions: z.number().int().min(100).default(1000),
  }).prefault({}),
  frequency: z.object({
    defaultMaxPerVisitorPerDay: z.number().int().min(0).max(1000).default(0),
    defaultMaxPerPage: z.number().int().min(0).max(20).default(1),
  }).prefault({}),
  creatives: z.object({
    allowedFormats: z.array(z.enum(['image', 'text'])).default(['image', 'text']),
    maxUploadBytes: z.number().int().min(10_000).max(5_000_000).default(300_000),
    allowedImageTypes: z.array(z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])).default(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    allowedDestinationProtocols: z.array(z.enum(['https:', 'http:'])).default(['https:']),
  }).prefault({}),
  publishers: z.object({
    requireDomainVerification: z.boolean().default(true),
    requireSiteReview: z.boolean().default(true),
    defaultRevenueShareBps: z.number().int().min(0).max(10000).default(7000),
    earningsHoldDays: z.number().int().min(0).max(120).default(30),
    minimumPayoutMicros: z.string().regex(/^\d+$/).default('50000000'),
  }).prefault({}),
  pricing: z.object({
    cpmEnabled: z.boolean().default(true),
    cpcEnabled: z.boolean().default(false),
    flatEnabled: z.boolean().default(true),
    minCpmMicros: z.string().regex(/^\d+$/).default('500000'),
    minCpcMicros: z.string().regex(/^\d+$/).default('50000'),
    minCampaignBudgetMicros: z.string().regex(/^\d+$/).default('50000000'),
    advertiserFeeBps: z.number().int().min(0).max(5000).default(0),
    defaultCurrency: z.string().length(3).default('USD'),
    enabledCurrencies: z.array(z.string().length(3)).default(['USD']),
    billingPeriod: z.enum(['monthly', 'weekly']).default('monthly'),
    invoicePrefix: z.string().min(1).max(10).default('BN'),
    refundWindowDays: z.number().int().min(0).max(365).default(90),
  }).prefault({}),
  api: z.object({
    authRateLimitPerMinute: z.number().int().min(1).max(1000).default(10),
    managementRateLimitPerMinute: z.number().int().min(10).max(100000).default(600),
    serveRateLimitPerMinutePerIp: z.number().int().min(10).max(100000).default(600),
  }).prefault({}),
  platform: z.object({
    maintenanceMode: z.boolean().default(false),
    maintenanceMessage: z.string().max(500).default(''),
    requireMfaForStaff: z.boolean().default(false),
    registrationOpen: z.boolean().default(true),
  }).prefault({}),
  branding: z.object({
    productName: z.string().min(1).max(80).default(DEFAULT_BRAND.productName),
    companyName: z.string().min(1).max(120).default(DEFAULT_BRAND.companyName),
    supportEmail: z.email().default(DEFAULT_BRAND.supportEmail),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default(DEFAULT_BRAND.colors.primary),
    termsUrl: z.string().max(500).default(DEFAULT_BRAND.legal.termsUrl),
    privacyUrl: z.string().max(500).default(DEFAULT_BRAND.legal.privacyUrl),
    docsUrl: z.string().max(500).default('/docs'),
  }).prefault({}),
  email: z.object({
    fromName: z.string().max(120).default(DEFAULT_BRAND.productName),
    fromAddress: z.email().default('no-reply@example.com'),
    templates: z.record(z.string(), z.object({ subject: z.string().max(200), body: z.string().max(10000) })).default({}),
  }).prefault({}),
});

export type PlatformSettings = z.infer<typeof settingsSchema>;
export const SETTINGS_GROUPS = ['tracking', 'ivt', 'frequency', 'creatives', 'publishers', 'pricing', 'api', 'platform', 'branding', 'email'] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export function defaultSettings(): PlatformSettings {
  return settingsSchema.parse({});
}

/** The subset safe to return from unauthenticated endpoints. */
export function publicSettings(s: PlatformSettings) {
  return {
    branding: s.branding,
    platform: { maintenanceMode: s.platform.maintenanceMode, maintenanceMessage: s.platform.maintenanceMessage, registrationOpen: s.platform.registrationOpen },
    pricing: { cpmEnabled: s.pricing.cpmEnabled, cpcEnabled: s.pricing.cpcEnabled, flatEnabled: s.pricing.flatEnabled, defaultCurrency: s.pricing.defaultCurrency, enabledCurrencies: s.pricing.enabledCurrencies, minCampaignBudgetMicros: s.pricing.minCampaignBudgetMicros, minCpmMicros: s.pricing.minCpmMicros, minCpcMicros: s.pricing.minCpcMicros },
    creatives: s.creatives,
  };
}
