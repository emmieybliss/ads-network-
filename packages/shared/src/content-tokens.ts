import { formatMoney } from './money';
import type { PlatformSettings } from './settings';

/**
 * Placeholders that content bodies (legal pages, policies, FAQs) may use, such
 * as {{companyName}}. They are filled from the platform settings when content
 * is served, so the operator changes company details once in
 * Settings > Branding instead of editing every document.
 *
 * A value the operator has not supplied yet (empty, or an example.com
 * address) is served as [[Label]], which the website shows as a clearly
 * marked gap, so an unfinished document can never pass for a finished one.
 */
export const CONTENT_TOKENS = {
  productName: 'Product name',
  companyName: 'Company name',
  companyAddress: 'Registered address',
  companyRegistration: 'Company registration number',
  governingLaw: 'Governing law',
  supportEmail: 'Support email',
  legalEmail: 'Legal email',
  privacyEmail: 'Privacy email',
  siteUrl: 'Website address',
  revenueShare: 'Default publisher revenue share',
  holdDays: 'Earnings hold period',
  minimumPayout: 'Minimum payout',
  payoutDay: 'Payout request day',
  minimumDeposit: 'Minimum deposit',
  refundWindowDays: 'Refund window',
  rawRetentionDays: 'Raw event retention',
  aggregateRetentionYears: 'Report retention',
  maxCreativeKb: 'Largest creative upload',
} as const;

export type ContentToken = keyof typeof CONTENT_TOKENS;

/** Where the operator sets each company detail. */
export const COMPANY_DETAIL_FIELDS = ['companyName', 'companyAddress', 'companyRegistration', 'governingLaw', 'supportEmail', 'legalEmail', 'privacyEmail'] as const;

function placeholderEmail(v: string) {
  return !v || /@example\.(com|org|net)$/i.test(v.trim());
}

function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Token values from settings. Missing values are null. */
export function contentTokenValues(s: PlatformSettings, siteUrl: string): Record<ContentToken, string | null> {
  const b = s.branding;
  const cur = s.pricing.defaultCurrency;
  const text = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
  const email = (v: string | undefined) => (v && !placeholderEmail(v) ? v.trim() : null);
  return {
    productName: text(b.productName),
    companyName: text(b.companyName),
    companyAddress: text(b.companyAddress),
    companyRegistration: text(b.companyRegistration),
    governingLaw: text(b.governingLaw),
    supportEmail: email(b.supportEmail),
    // Legal and privacy requests go to the support address until their own are set.
    legalEmail: email(b.legalEmail) ?? email(b.supportEmail),
    privacyEmail: email(b.privacyEmail) ?? email(b.supportEmail),
    siteUrl: /localhost|127\.0\.0\.1/.test(siteUrl) ? null : siteUrl.replace(/\/$/, ''),
    revenueShare: `${(s.publishers.defaultRevenueShareBps / 100).toString()}%`,
    holdDays: `${s.publishers.earningsHoldDays} days`,
    minimumPayout: formatMoney(s.publishers.minimumPayoutMicros, cur),
    payoutDay: s.publishers.autoPayoutDay ? `the ${ordinal(s.publishers.autoPayoutDay)} of each month` : 'the date you request it',
    minimumDeposit: formatMoney(s.pricing.minDepositMicros, cur),
    refundWindowDays: `${s.pricing.refundWindowDays} days`,
    rawRetentionDays: `${s.tracking.rawEventRetentionDays} days`,
    aggregateRetentionYears: `${Math.round(s.tracking.aggregateRetentionDays / 365)} years`,
    maxCreativeKb: `${Math.round(s.creatives.maxUploadBytes / 1000)} KB`,
  };
}

/** Replace {{token}} with its value, or [[Label]] when the value is missing. Unknown tokens are left as written. */
export function fillContentTokens(body: string, values: Record<string, string | null>): string {
  return body.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, key: string) => {
    if (!(key in CONTENT_TOKENS)) return whole;
    const v = values[key];
    return v ?? `[[${CONTENT_TOKENS[key as ContentToken]}]]`;
  });
}

/** Company details that are still missing, for the admin checklist. */
export function missingCompanyDetails(s: PlatformSettings): Array<{ key: string; label: string }> {
  const values = contentTokenValues(s, '');
  return COMPANY_DETAIL_FIELDS.filter((k) => values[k] === null).map((k) => ({ key: k, label: CONTENT_TOKENS[k] }));
}
