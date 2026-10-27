/**
 * Central brand configuration. Every component that renders a product name,
 * company name, support address or legal link must read it from here (or
 * from the public settings endpoint, which starts from these defaults and
 * applies administrator overrides). Do not hardcode brand details elsewhere.
 *
 * No production domain exists yet, so URLs default to local development
 * addresses and are expected to be supplied by environment variables.
 */
export interface BrandConfig {
  productName: string;
  shortName: string;
  companyName: string;
  supportEmail: string;
  publicSiteUrl: string;
  apiUrl: string;
  logoText: string;
  colors: { primary: string; primaryHover: string; accent: string };
  legal: { termsUrl: string; privacyUrl: string; advertiserPolicyUrl: string; publisherPolicyUrl: string };
}

export const DEFAULT_BRAND: BrandConfig = {
  productName: 'BlissNova Ad Network',
  shortName: 'BlissNova',
  companyName: 'BlissNova Technologies',
  supportEmail: 'support@example.com',
  publicSiteUrl: 'http://localhost:3000',
  apiUrl: 'http://localhost:4000',
  logoText: 'BlissNova',
  colors: { primary: '#4f46e5', primaryHover: '#4338ca', accent: '#7c3aed' },
  legal: {
    termsUrl: '/legal/terms',
    privacyUrl: '/legal/privacy',
    advertiserPolicyUrl: '/policies/advertisers',
    publisherPolicyUrl: '/policies/publishers',
  },
};

export function brandFromEnv(env: Record<string, string | undefined>): BrandConfig {
  return {
    ...DEFAULT_BRAND,
    productName: env.BRAND_PRODUCT_NAME || DEFAULT_BRAND.productName,
    companyName: env.BRAND_COMPANY_NAME || DEFAULT_BRAND.companyName,
    supportEmail: env.BRAND_SUPPORT_EMAIL || DEFAULT_BRAND.supportEmail,
    publicSiteUrl: env.PUBLIC_SITE_URL || DEFAULT_BRAND.publicSiteUrl,
    apiUrl: env.PUBLIC_API_URL || DEFAULT_BRAND.apiUrl,
  };
}
