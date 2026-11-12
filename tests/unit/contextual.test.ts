import { describe, expect, it } from 'vitest';
import { classifyPage, decide, signalsHash, type CampaignCandidate, type RequestContext } from '@blissnova/ad-decision';
import { brandSafetyAllows, SITE_CATEGORY_TOPICS, TOPIC_IDS, toMicros } from '@blissnova/shared';

describe('page classifier: topics', () => {
  const cases: Array<[string, { title: string; description?: string; text: string; path?: string }, string]> = [
    ['travel', { title: 'A weekend in Lisbon on a small budget', text: 'Flights take under three hours and the airport is close to the centre. Stay in a hostel, buy a transport card for the tram, and visit the viewpoints.', path: '/lisbon-weekend' }, 'travel'],
    ['personal finance', { title: 'Index funds explained in plain words', text: 'An index fund buys every stock in a market index. Fees are low, and the expense ratio matters over decades of retirement savings.' }, 'finance'],
    ['recipe', { title: 'A 20-minute weeknight tomato pasta', text: 'Cook the spaghetti, simmer the tomato sauce with garlic and olive oil, then toss with basil and cheese. A quick dinner recipe.' }, 'food'],
    ['houseplants', { title: 'Keeping houseplants alive', text: 'Water when the soil is dry. Pots without drainage holes rot the roots. Repot when roots circle the pot and give ferns some shade.' }, 'home_garden'],
    ['sports', { title: 'Late goal wins the championship', text: 'The striker scored in the final minute as the team won the league. Fans filled the stadium for the playoff match against last season\'s champions.' }, 'sports'],
    ['technology', { title: 'How to choose a laptop for programming', text: 'Developers need a fast processor, enough memory and a good keyboard. We compare operating systems, battery life and software support.' }, 'technology'],
    ['gaming', { title: 'Our review of the new open world video game', text: 'The gameplay is excellent on PlayStation and Xbox, with a long campaign, multiplayer modes and a tough boss fight.' }, 'gaming'],
  ];
  for (const [name, page, topic] of cases) {
    it(`detects ${name}`, () => {
      const c = classifyPage(page);
      expect(c.primary, JSON.stringify(c.topics)).toBe(topic);
      expect(c.safety).toBe('safe');
      expect(c.topics[0]!.confidence).toBeGreaterThan(0.3);
      expect(c.topics.length).toBeLessThanOrEqual(3);
      expect(TOPIC_IDS).toContain(c.primary!);
    });
  }

  it('reports no topic when the evidence is thin', () => {
    expect(classifyPage({ title: 'Hello', text: 'Welcome to my page. Thanks for stopping by.' }).topics).toEqual([]);
    expect(classifyPage({}).enoughText).toBe(false);
  });

  it('leaves non-English pages uncategorized (they fall back to the site category)', () => {
    const c = classifyPage({ title: 'Un fin de semana en Lisboa', text: 'Vuelos, hoteles y tranvías para un viaje barato.', lang: 'es' });
    expect(c.topics).toEqual([]);
    expect(c.enoughText).toBe(false);
  });

  it('counts plurals and phrases', () => {
    const c = classifyPage({ title: 'Cheap flights and hotels', text: 'Compare flights, hotels and travel insurance for your next vacation. Our itinerary covers the old town and the beach.' });
    expect(c.primary).toBe('travel');
    expect(c.terms).toEqual(expect.arrayContaining(['flight', 'hotel']));
  });

  it('hashes the same signals the same way and notices a change', () => {
    const a = { title: 'A', text: 'one two three' };
    expect(signalsHash(a)).toBe(signalsHash({ ...a }));
    expect(signalsHash(a)).not.toBe(signalsHash({ ...a, text: 'one two four' }));
  });

  it('maps every site category to valid topics', () => {
    for (const ids of Object.values(SITE_CATEGORY_TOPICS)) for (const id of ids) expect(TOPIC_IDS).toContain(id);
  });
});

describe('page classifier: brand safety', () => {
  it('flags graphic violence in the title as high risk', () => {
    const c = classifyPage({ title: 'Gunman kills three in mass shooting', text: 'Police said the death toll rose. A massacre, officials said.' });
    expect(c.safety).toBe('high');
    expect(c.flags.map((f) => f.category)).toContain('violence');
  });

  it('rates ordinary crime reporting on a news page lower than graphic content', () => {
    const c = classifyPage({ title: 'City council votes on new budget', text: 'The mayor said officials will investigate a robbery reported downtown last week. Police arrested one suspect. The council also approved new bus routes and the election date.' });
    expect(['low', 'medium']).toContain(c.safety);
    expect(c.primary).toBe('news');
  });

  it('flags adult content', () => {
    const c = classifyPage({ title: 'Free porn videos', text: 'xxx explicit sex videos' });
    expect(c.safety).toBe('high');
    expect(c.flags[0]!.category).toBe('adult');
  });

  it('never makes gambling more than medium risk', () => {
    const c = classifyPage({ title: 'Best online casino bonus and free spins', text: 'Play slots, roulette, blackjack and poker. Sports betting odds and jackpot offers.' });
    expect(c.safety).toBe('medium');
    expect(c.flags.find((f) => f.category === 'gambling')?.risk).toBe('medium');
  });

  it('treats drugs on a medical page more leniently', () => {
    const text = 'Doctors at the clinic explain treatment for opioid addiction and overdose: medication, therapy and patient support. Symptoms and diagnosis are covered.';
    const medical = classifyPage({ title: 'Treating opioid addiction: what patients should know', text });
    const plain = classifyPage({ title: 'Opioid addiction and overdose', text: 'Opioid addiction, overdose, narcotics and drug abuse.' });
    const rank = { safe: 0, low: 1, medium: 2, high: 3 };
    expect(medical.primary).toBe('health');
    expect(rank[medical.safety]).toBeLessThanOrEqual(rank[plain.safety]);
  });

  it('keeps ordinary pages safe', () => {
    expect(classifyPage({ title: 'Five small habits for a calmer workday', text: 'Take short breaks, drink water and go for a walk at lunch. Healthy habits reduce stress.' }).safety).toBe('safe');
  });
});

describe('brand-safety modes', () => {
  it('strict takes only checked, safe pages; standard adds low and unchecked; relaxed adds medium', () => {
    expect(['safe', 'low', 'medium', 'high', 'unknown'].filter((l) => brandSafetyAllows('strict', l as never))).toEqual(['safe']);
    expect(['safe', 'low', 'medium', 'high', 'unknown'].filter((l) => brandSafetyAllows('standard', l as never))).toEqual(['safe', 'low', 'unknown']);
    expect(['safe', 'low', 'medium', 'high', 'unknown'].filter((l) => brandSafetyAllows('relaxed', l as never))).toEqual(['safe', 'low', 'medium', 'unknown']);
    expect(brandSafetyAllows(undefined, 'medium')).toBe(false);
  });
});

describe('decision: topics and brand safety', () => {
  const NOW = Date.UTC(2026, 5, 15, 12);
  const camp = (id: string, t: Partial<CampaignCandidate['targeting']> = {}): CampaignCandidate => ({
    id, orgId: 'o', status: 'active', priority: 5, pricingModel: 'cpm', rateMicros: toMicros('2'), currency: 'USD', lifetimeBudgetMicros: toMicros('100'), spentMicros: 0n,
    dailyBudgetMicros: null, startAt: NOW - 1000, endAt: null, timezone: 'UTC', pacing: 'asap',
    targeting: { countries: [], devices: [], siteCategories: [], keywords: [], includeSiteIds: [], excludeSiteIds: [], includeUnitIds: [], excludeUnitIds: [], requirePersonalized: false, ...t },
    creatives: [{ id: `${id}-cr`, format: 'text', width: null, height: null }],
  });
  const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
    requestId: 'r', now: NOW, siteId: 's', siteCategory: 'general', siteAllowedFormats: ['text'], unitId: 'u', unitFormats: ['text'], unitWidth: null, unitHeight: null, unitResponsive: true,
    country: 'US', device: 'desktop', keywords: [], personalized: false, blockedCountries: [], excludeCampaignIds: [], cpcEnabled: true, spentToday: () => 0n, ...over,
  });
  const ids = (r: ReturnType<typeof decide>) => r.ranked.map((x) => x.campaign.id).sort();

  it('serves topic campaigns only on matching pages', () => {
    const cs = [camp('travel', { topics: ['travel'] }), camp('any')];
    expect(ids(decide(cs, ctx({ pageTopics: ['travel', 'food'], pageSafety: 'safe' })))).toEqual(['any', 'travel']);
    const r = decide(cs, ctx({ pageTopics: ['finance'], pageSafety: 'safe' }));
    expect(ids(r)).toEqual(['any']);
    expect(r.rejected).toContainEqual({ campaignId: 'travel', reason: 'topic' });
    expect(ids(decide(cs, ctx({})))).toEqual(['any']);
  });

  it('keeps campaigns off excluded topics', () => {
    const r = decide([camp('no-news', { excludeTopics: ['news'] })], ctx({ pageTopics: ['news'], pageSafety: 'safe' }));
    expect(r.rejected).toContainEqual({ campaignId: 'no-news', reason: 'excluded_topic' });
  });

  it('applies each campaign\'s brand-safety level', () => {
    const cs = [camp('strict', { brandSafety: 'strict' }), camp('standard'), camp('relaxed', { brandSafety: 'relaxed' })];
    expect(ids(decide(cs, ctx({ pageSafety: 'safe' })))).toEqual(['relaxed', 'standard', 'strict']);
    expect(ids(decide(cs, ctx({ pageSafety: 'unknown' })))).toEqual(['relaxed', 'standard']);
    expect(ids(decide(cs, ctx({ pageSafety: 'medium' })))).toEqual(['relaxed']);
    expect(ids(decide(cs, ctx({ pageSafety: 'high' })))).toEqual([]);
  });
});
