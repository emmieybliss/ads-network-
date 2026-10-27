import { describe, expect, it } from 'vitest';
import { ctr, effectiveCpcMicros, effectiveCpmMicros, METRIC_DEFINITIONS, toMicros } from '@blissnova/shared';

describe('reported metrics', () => {
  it('CTR is valid clicks divided by valid impressions, as a percentage', () => {
    expect(ctr(5, 1000)).toBeCloseTo(0.5, 10);
    expect(ctr(1, 1)).toBe(100);
    expect(ctr(0, 1000)).toBe(0);
  });

  it('CTR is null, not zero or Infinity, when there were no impressions', () => {
    // Showing 0% where nothing was served would misrepresent the data, and
    // dividing by zero would put Infinity in a report.
    expect(ctr(0, 0)).toBeNull();
    expect(ctr(3, 0)).toBeNull();
  });

  it('effective CPM is spend per thousand impressions', () => {
    expect(effectiveCpmMicros(toMicros('10'), 5000)).toBe(toMicros('2'));
    expect(effectiveCpmMicros(toMicros('0'), 100)).toBe(0n);
    expect(effectiveCpmMicros(toMicros('10'), 0)).toBeNull();
  });

  it('effective CPC is spend per click', () => {
    expect(effectiveCpcMicros(toMicros('18'), 100)).toBe(toMicros('0.18'));
    expect(effectiveCpcMicros(toMicros('18'), 0)).toBeNull();
  });

  it('documents every metric it reports, so a number in the UI can be explained', () => {
    for (const key of ['served', 'rendered', 'validImpressions', 'viewableImpressions', 'invalidImpressions', 'validClicks', 'billableImpressions', 'ctr', 'spend', 'ecpm', 'ecpc', 'estimatedEarnings', 'finalizedEarnings']) {
      expect(METRIC_DEFINITIONS[key], key).toBeTruthy();
    }
    // "Served" and "impression" must not be conflated: that is how networks
    // overstate delivery.
    expect(METRIC_DEFINITIONS.served).toMatch(/not an impression/i);
    // The viewability definition must state the IAB threshold, not just "in view".
    expect(METRIC_DEFINITIONS.viewableImpressions).toMatch(/50%/);
    expect(METRIC_DEFINITIONS.viewableImpressions).toMatch(/1 continuous second/i);
    // CTR must be defined over *valid* events.
    expect(METRIC_DEFINITIONS.ctr).toMatch(/valid/i);
  });
});
