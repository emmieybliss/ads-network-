import { describe, expect, it } from 'vitest';
import { dayFraction, decide, effectiveDailyBudget, pacingAllows, unitCostMicros, type CampaignCandidate, type RequestContext } from '@blissnova/ad-decision';
import { toMicros } from '@blissnova/shared';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

function campaign(over: Partial<CampaignCandidate> = {}): CampaignCandidate {
  return {
    id: over.id ?? 'c1',
    orgId: 'org1',
    status: 'active',
    priority: 5,
    pricingModel: 'cpm',
    rateMicros: toMicros('2'),
    currency: 'USD',
    lifetimeBudgetMicros: toMicros('1000'),
    spentMicros: 0n,
    dailyBudgetMicros: null,
    startAt: NOW - 86_400_000,
    endAt: null,
    timezone: 'UTC',
    pacing: 'asap',
    targeting: { countries: [], devices: [], siteCategories: [], keywords: [], includeSiteIds: [], excludeSiteIds: [], includeUnitIds: [], excludeUnitIds: [], requirePersonalized: false },
    creatives: [{ id: 'cr1', format: 'image', width: 300, height: 250 }],
    ...over,
  };
}

function ctx(over: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: 'req-1',
    now: NOW,
    siteId: 'site1',
    siteCategory: 'news',
    siteAllowedFormats: ['image', 'text'],
    unitId: 'unit1',
    unitFormats: ['image', 'text'],
    unitWidth: 300,
    unitHeight: 250,
    unitResponsive: false,
    country: 'US',
    device: 'desktop',
    keywords: [],
    personalized: false,
    blockedCountries: [],
    excludeCampaignIds: [],
    cpcEnabled: true,
    spentToday: () => 0n,
    ...over,
  };
}

const reasonFor = (r: ReturnType<typeof decide>, id: string) => r.rejected.find((x) => x.campaignId === id)?.reason;

describe('ad decision engine', () => {
  it('ranks an eligible campaign', () => {
    const r = decide([campaign()], ctx());
    expect(r.ranked).toHaveLength(1);
    expect(r.ranked[0]!.campaign.id).toBe('c1');
    expect(r.ranked[0]!.creative.id).toBe('cr1');
  });

  it('is deterministic: the same request and candidates always rank the same way', () => {
    const cands = [campaign({ id: 'a' }), campaign({ id: 'b' }), campaign({ id: 'c' })];
    const first = decide(cands, ctx()).ranked.map((x) => x.campaign.id);
    for (let i = 0; i < 25; i++) {
      expect(decide(cands, ctx()).ranked.map((x) => x.campaign.id)).toEqual(first);
    }
  });

  it('is independent of the order candidates arrive in', () => {
    const a = campaign({ id: 'a' });
    const b = campaign({ id: 'b' });
    const c = campaign({ id: 'c' });
    const forward = decide([a, b, c], ctx()).ranked.map((x) => x.campaign.id);
    const backward = decide([c, b, a], ctx()).ranked.map((x) => x.campaign.id);
    expect(backward).toEqual(forward);
  });

  it('breaks ties by request, so one campaign does not take every impression', () => {
    const cands = [campaign({ id: 'a' }), campaign({ id: 'b' })];
    const winners = new Set<string>();
    for (let i = 0; i < 200; i++) {
      winners.add(decide(cands, ctx({ requestId: `req-${i}` })).ranked[0]!.campaign.id);
    }
    expect(winners.size).toBe(2);
  });

  it('prefers higher priority over higher expected value', () => {
    const cheapButUrgent = campaign({ id: 'high', priority: 9, rateMicros: toMicros('0.50') });
    const expensive = campaign({ id: 'low', priority: 2, rateMicros: toMicros('50') });
    const r = decide([expensive, cheapButUrgent], ctx());
    expect(r.ranked[0]!.campaign.id).toBe('high');
  });

  it('prefers the higher paying campaign at equal priority', () => {
    const r = decide([campaign({ id: 'cheap', rateMicros: toMicros('1') }), campaign({ id: 'rich', rateMicros: toMicros('20') })], ctx());
    expect(r.ranked[0]!.campaign.id).toBe('rich');
  });

  describe('eligibility', () => {
    it('rejects campaigns that are not active', () => {
      for (const status of ['draft', 'paused', 'pending_approval', 'completed', 'rejected', 'suspended', 'archived']) {
        const r = decide([campaign({ status })], ctx());
        expect(r.ranked, status).toHaveLength(0);
        expect(reasonFor(r, 'c1'), status).toBe('status');
      }
    });

    it('rejects a campaign that has not started or has ended', () => {
      expect(reasonFor(decide([campaign({ startAt: NOW + 3600_000 })], ctx()), 'c1')).toBe('schedule');
      expect(reasonFor(decide([campaign({ endAt: NOW - 1 })], ctx()), 'c1')).toBe('schedule');
    });

    it('rejects a campaign whose lifetime budget is spent', () => {
      const c = campaign({ lifetimeBudgetMicros: toMicros('10'), spentMicros: toMicros('10') });
      expect(reasonFor(decide([c], ctx()), 'c1')).toBe('budget');
    });

    it('rejects a campaign whose budget cannot cover one more impression', () => {
      // $2 CPM is 2,000 micros per impression; 1,500 micros left is not enough.
      const c = campaign({ lifetimeBudgetMicros: toMicros('1000'), spentMicros: toMicros('1000') - 1_500n });
      expect(reasonFor(decide([c], ctx()), 'c1')).toBe('budget');
    });

    it('rejects a campaign that has spent its daily budget', () => {
      const c = campaign({ dailyBudgetMicros: toMicros('10') });
      const r = decide([c], ctx({ spentToday: () => toMicros('10') }));
      expect(reasonFor(r, 'c1')).toBe('daily_budget');
    });

    it('honours country, device, category and keyword targeting', () => {
      expect(reasonFor(decide([campaign({ targeting: { ...campaign().targeting, countries: ['GB'] } })], ctx({ country: 'US' })), 'c1')).toBe('country');
      expect(reasonFor(decide([campaign({ targeting: { ...campaign().targeting, devices: ['mobile'] } })], ctx({ device: 'desktop' })), 'c1')).toBe('device');
      expect(reasonFor(decide([campaign({ targeting: { ...campaign().targeting, siteCategories: ['sports'] } })], ctx({ siteCategory: 'news' })), 'c1')).toBe('site_category');
      expect(reasonFor(decide([campaign({ targeting: { ...campaign().targeting, keywords: ['coffee'] } })], ctx({ keywords: ['tea'] })), 'c1')).toBe('keywords');
    });

    it('matches when the page carries one of several targeted keywords', () => {
      const c = campaign({ targeting: { ...campaign().targeting, keywords: ['coffee', 'tea'] } });
      expect(decide([c], ctx({ keywords: ['news', 'tea'] })).ranked).toHaveLength(1);
    });

    it('treats an empty targeting list as "no restriction", not "matches nothing"', () => {
      expect(decide([campaign()], ctx({ country: 'ZZ', device: 'unknown' })).ranked).toHaveLength(1);
    });

    it('honours site include and exclude lists', () => {
      expect(reasonFor(decide([campaign({ targeting: { ...campaign().targeting, includeSiteIds: ['other'] } })], ctx()), 'c1')).toBe('site_list');
      expect(reasonFor(decide([campaign({ targeting: { ...campaign().targeting, excludeSiteIds: ['site1'] } })], ctx()), 'c1')).toBe('site_list');
    });

    it('honours unit include and exclude lists', () => {
      expect(reasonFor(decide([campaign({ targeting: { ...campaign().targeting, includeUnitIds: ['other'] } })], ctx()), 'c1')).toBe('unit_list');
      expect(reasonFor(decide([campaign({ targeting: { ...campaign().targeting, excludeUnitIds: ['unit1'] } })], ctx()), 'c1')).toBe('unit_list');
    });

    it('will not serve a personalisation-requiring campaign without consent', () => {
      const c = campaign({ targeting: { ...campaign().targeting, requirePersonalized: true } });
      expect(reasonFor(decide([c], ctx({ personalized: false })), 'c1')).toBe('personalization');
      expect(decide([c], ctx({ personalized: true })).ranked).toHaveLength(1);
    });

    it('refuses countries the platform has blocked, whatever the campaign targets', () => {
      const c = campaign({ targeting: { ...campaign().targeting, countries: ['IR'] } });
      expect(reasonFor(decide([c], ctx({ country: 'IR', blockedCountries: ['IR'] })), 'c1')).toBe('blocked_country');
    });

    it('does not serve the same campaign twice on one page', () => {
      expect(reasonFor(decide([campaign()], ctx({ excludeCampaignIds: ['c1'] })), 'c1')).toBe('already_on_page');
    });

    it('rejects CPC campaigns when the platform has CPC turned off', () => {
      const c = campaign({ pricingModel: 'cpc', rateMicros: toMicros('0.10') });
      expect(reasonFor(decide([c], ctx({ cpcEnabled: false })), 'c1')).toBe('pricing_disabled');
      expect(decide([c], ctx({ cpcEnabled: true })).ranked).toHaveLength(1);
    });
  });

  describe('creative fit', () => {
    it('rejects a campaign with no creative the unit can show', () => {
      const textOnlyUnit = ctx({ unitFormats: ['text'] });
      expect(reasonFor(decide([campaign()], textOnlyUnit), 'c1')).toBe('no_creative');
    });

    it('respects the formats the publisher allows on the site', () => {
      expect(reasonFor(decide([campaign()], ctx({ siteAllowedFormats: ['text'] })), 'c1')).toBe('no_creative');
    });

    it('requires an exact pixel match on a fixed-size unit', () => {
      const c = campaign({ creatives: [{ id: 'wrong', format: 'image', width: 728, height: 90 }] });
      expect(reasonFor(decide([c], ctx({ unitWidth: 300, unitHeight: 250 })), 'c1')).toBe('no_creative');
    });

    it('accepts any size on a responsive unit', () => {
      const c = campaign({ creatives: [{ id: 'any', format: 'image', width: 728, height: 90 }] });
      expect(decide([c], ctx({ unitResponsive: true, unitWidth: null, unitHeight: null })).ranked).toHaveLength(1);
    });

    it('picks a fitting creative when the campaign has several', () => {
      const c = campaign({
        creatives: [
          { id: 'wrong', format: 'image', width: 728, height: 90 },
          { id: 'right', format: 'image', width: 300, height: 250 },
        ],
      });
      expect(decide([c], ctx()).ranked[0]!.creative.id).toBe('right');
    });
  });

  describe('pacing', () => {
    const paced = (over: Partial<CampaignCandidate>) => campaign({ pacing: 'even', dailyBudgetMicros: toMicros('100'), ...over });

    it('lets an even-paced campaign through when it is behind schedule', () => {
      // Half the day gone in UTC, nothing spent today.
      const r = pacingAllows(paced({}), 0n, Date.UTC(2026, 5, 15, 12, 0, 0));
      expect(r.ok).toBe(true);
    });

    it('holds an even-paced campaign back when it is ahead of schedule', () => {
      // One hour into the day, 90% of the daily budget already spent.
      const r = pacingAllows(paced({}), toMicros('90'), Date.UTC(2026, 5, 15, 1, 0, 0));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('pacing');
    });

    it('stops an even-paced campaign that would exceed the daily budget outright', () => {
      const r = pacingAllows(paced({}), toMicros('100'), Date.UTC(2026, 5, 15, 23, 0, 0));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('daily_budget');
    });

    it('never holds back an asap campaign that still has daily budget', () => {
      const r = pacingAllows(campaign({ pacing: 'asap', dailyBudgetMicros: toMicros('100') }), toMicros('99'), Date.UTC(2026, 5, 15, 0, 30, 0));
      expect(r.ok).toBe(true);
    });

    it('does not pace a campaign with no daily budget and no end date', () => {
      expect(pacingAllows(campaign({ pacing: 'even', dailyBudgetMicros: null, endAt: null }), toMicros('999'), NOW).ok).toBe(true);
    });

    it('rejects an even-paced campaign that is running ahead', () => {
      const c = campaign({ pacing: 'even', dailyBudgetMicros: toMicros('100') });
      const r = decide([c], ctx({ now: Date.UTC(2026, 5, 15, 1, 0, 0), spentToday: () => toMicros('90') }));
      expect(reasonFor(r, 'c1')).toBe('pacing');
    });

    it('measures the day in the campaign time zone, not the server zone', () => {
      const noonUtc = Date.UTC(2026, 5, 15, 12, 0, 0);
      expect(dayFraction(noonUtc, 'UTC')).toBeCloseTo(0.5, 3);
      // Tokyo is UTC+9, so 12:00 UTC is 21:00 there.
      expect(dayFraction(noonUtc, 'Asia/Tokyo')).toBeCloseTo(21 / 24, 3);
    });

    it('falls back to a sane day fraction for an unknown time zone', () => {
      const f = dayFraction(NOW, 'Not/AZone');
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    });
  });

  describe('cost of one delivery', () => {
    it('charges a thousandth of the CPM rate per impression', () => {
      expect(unitCostMicros({ pricingModel: 'cpm', rateMicros: toMicros('2.50') })).toBe(2_500n);
    });

    it('charges the full rate per click for CPC', () => {
      expect(unitCostMicros({ pricingModel: 'cpc', rateMicros: toMicros('0.18') })).toBe(toMicros('0.18'));
    });

    it('charges nothing per delivery for a flat-rate campaign', () => {
      // Flat-rate cost is allocated daily, not per impression.
      expect(unitCostMicros({ pricingModel: 'flat', rateMicros: toMicros('500') })).toBe(0n);
    });
  });

  describe('effective daily budget', () => {
    it('uses the explicit daily budget when there is one', () => {
      expect(effectiveDailyBudget(campaign({ dailyBudgetMicros: toMicros('10') }), NOW)).toBe(toMicros('10'));
    });

    it('spreads the remaining budget over the days left for an even-paced campaign', () => {
      const c = campaign({ pacing: 'even', dailyBudgetMicros: null, lifetimeBudgetMicros: toMicros('100'), spentMicros: toMicros('40'), endAt: NOW + 4 * 86_400_000 });
      expect(effectiveDailyBudget(c, NOW)).toBe(toMicros('15')); // $60 left over 4 days
    });

    it('does not divide by zero on the last day of the campaign', () => {
      const c = campaign({ pacing: 'even', dailyBudgetMicros: null, lifetimeBudgetMicros: toMicros('100'), spentMicros: 0n, endAt: NOW + 1000 });
      expect(effectiveDailyBudget(c, NOW)).toBe(toMicros('100'));
    });

    it('is unlimited for an asap campaign with no daily budget', () => {
      expect(effectiveDailyBudget(campaign({ pacing: 'asap', dailyBudgetMicros: null }), NOW)).toBeNull();
    });
  });
});
