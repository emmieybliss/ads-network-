/**
 * Metric definitions shared by API reports and dashboard labels.
 * CTR is always computed from summed counts: valid clicks / valid impressions * 100.
 * Never average per-row CTR percentages.
 */
export function ctr(validClicks: number, validImpressions: number): number | null {
  if (!validImpressions) return null;
  return (validClicks / validImpressions) * 100;
}

export function effectiveCpmMicros(spendMicros: bigint, impressions: number): bigint | null {
  if (!impressions) return null;
  return (spendMicros * 1000n) / BigInt(impressions);
}

export function effectiveCpcMicros(spendMicros: bigint, clicks: number): bigint | null {
  if (!clicks) return null;
  return spendMicros / BigInt(clicks);
}

export const METRIC_DEFINITIONS: Record<string, string> = {
  served: 'Ad responses returned by the ad server. A served ad is not an impression.',
  rendered: 'Creatives the ad tag reported as inserted into the page with a valid, unexpired delivery token.',
  validImpressions: 'Rendered impressions that passed all invalid-traffic checks.',
  viewableImpressions: 'Valid impressions where at least 50% of the creative pixels were in the viewport for at least 1 continuous second (IAB/MRC display standard).',
  invalidImpressions: 'Rendered impressions rejected by invalid-traffic checks (duplicates, expired or replayed tokens, crawler signals, domain mismatch, rate anomalies, or manual exclusion).',
  validClicks: 'Clicks through the tracking redirect that passed invalid-traffic checks. At most one valid click per delivered impression.',
  billableImpressions: 'Valid impressions charged to the campaign. Valid impressions delivered after a budget is exhausted are not billable.',
  ctr: 'Valid clicks divided by valid impressions, multiplied by 100. Aggregated from totals, never averaged.',
  spend: 'Billable charges to the advertiser, in the campaign currency.',
  ecpm: 'Spend divided by valid impressions, multiplied by 1,000.',
  ecpc: 'Spend divided by valid clicks.',
  estimatedEarnings: 'Publisher share of billable charges that are still inside the review hold period and may be adjusted by invalid-traffic review.',
  finalizedEarnings: 'Publisher earnings that passed the hold period and are available for payout.',
  viewabilityRate: 'Viewable impressions divided by valid impressions, multiplied by 100.',
  avgTimeInView: 'Mean time a creative was at least 50% in view in a visible tab, over impressions whose time in view was reported when the visitor left the page.',
  pageviews: 'Pages where the ad tag requested at least one ad.',
  sessions: 'Visits that start with a page reached from outside the site, or with no referrer. Counted without cookies or device storage.',
  pagesPerSession: 'Page views divided by sessions.',
  sessionRpm: 'Estimated earnings divided by sessions, multiplied by 1,000.',
  pageRpm: 'Estimated earnings divided by page views, multiplied by 1,000.',
  trafficSource: 'Where the page view came from, judged by the referring host only: search, social, referral, direct (no referrer) or internal navigation.',
  conversions: 'Conversions the advertiser reported by pixel or postback for a valid click, inside the campaign attribution window. Counted on the day they happen.',
  conversionRate: 'Conversions divided by valid clicks, multiplied by 100.',
  cpa: 'Spend divided by conversions.',
  roas: 'Reported conversion value divided by spend.',
  reach: 'Distinct visitors who saw at least one valid impression. Only visitors who allowed personalization carry an id, so this counts those visitors only.',
  frequency: 'Valid impressions per reached visitor, among visitors who allowed personalization.',
  fillRate: 'Filled ad requests divided by ad requests, multiplied by 100.',
};
