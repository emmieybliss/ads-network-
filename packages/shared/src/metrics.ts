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
};
