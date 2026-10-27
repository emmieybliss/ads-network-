import { DEFAULT_BRAND } from '@blissnova/shared';

/**
 * Brand configuration for the web app. Defaults come from the shared brand
 * file; deployments override them with NEXT_PUBLIC_* variables. Administrator
 * changes made in Settings > Branding are served by /public/config and take
 * precedence where the page fetches it.
 */
export const brand = {
  productName: process.env.NEXT_PUBLIC_BRAND_PRODUCT_NAME || DEFAULT_BRAND.productName,
  shortName: process.env.NEXT_PUBLIC_BRAND_SHORT_NAME || DEFAULT_BRAND.shortName,
  companyName: process.env.NEXT_PUBLIC_BRAND_COMPANY_NAME || DEFAULT_BRAND.companyName,
  supportEmail: process.env.NEXT_PUBLIC_BRAND_SUPPORT_EMAIL || DEFAULT_BRAND.supportEmail,
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_BRAND.publicSiteUrl,
  legal: DEFAULT_BRAND.legal,
};
