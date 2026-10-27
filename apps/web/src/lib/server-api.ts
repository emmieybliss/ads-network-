import 'server-only';

/**
 * Server-side reads of public API data for marketing pages. Failures return
 * null so a page still renders (with honest "not configured yet" copy) when the
 * API is down or the operator has not set something up.
 */
const API = (process.env.API_INTERNAL_URL || 'http://localhost:4000').replace(/\/$/, '');

export async function publicGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}/api/v1${path}`, { next: { revalidate: 60 }, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return ((await res.json()) as { data: T }).data;
  } catch {
    return null;
  }
}

export interface PricingPlan { audience: 'advertiser' | 'publisher'; name: string; summary: string; price_label: string; features: string[]; cta_label: string; highlighted: boolean }
export interface ContentItem { kind: string; slug: string; title: string; body: string; url: string | null; sort_order: number; updated_at: string }
export interface PublicConfig {
  brand: { productName: string; companyName: string; supportEmail: string; publicSiteUrl: string; apiUrl: string };
  pricing: { cpmEnabled: boolean; cpcEnabled: boolean; flatEnabled: boolean; defaultCurrency: string; minCampaignBudgetMicros: string; minCpmMicros: string; minCpcMicros: string };
  platform: { registrationOpen: boolean; maintenanceMode: boolean; maintenanceMessage: string };
  eligibility: {
    minMonthlyPageviews: number | null; requireOriginalContent: boolean; requirePrivacyPolicy: boolean; requireContactInformation: boolean; requireTrafficIntegrity: boolean;
    prohibitedCategories: string[]; allowedCountries: string[]; allowedLanguages: string[]; prohibitedContent: string[]; notes: string;
  };
  metricDefinitions: Record<string, string>;
  creatives: { allowedFormats: string[]; maxUploadBytes: number; allowedImageTypes: string[] };
}
