import { createHash } from 'node:crypto';

/**
 * Pure, deterministic campaign selection. It has no I/O: the API supplies a
 * snapshot of eligible campaigns plus request context, and performs atomic
 * frequency-cap and budget reservations (Redis) on the ranked result,
 * falling through to the next candidate when a reservation is refused.
 */
export interface Targeting {
  countries: string[];
  devices: string[];
  siteCategories: string[];
  keywords: string[];
  includeSiteIds: string[];
  excludeSiteIds: string[];
  includeUnitIds: string[];
  excludeUnitIds: string[];
  requirePersonalized: boolean;
}

export interface CreativeCandidate { id: string; format: 'image' | 'text'; width: number | null; height: number | null }

export interface CampaignCandidate {
  id: string;
  orgId: string;
  status: string;
  priority: number;          // 1..10 advertiser priority + admin boost
  pricingModel: 'cpm' | 'cpc' | 'flat';
  rateMicros: bigint;
  currency: string;
  lifetimeBudgetMicros: bigint;
  spentMicros: bigint;
  dailyBudgetMicros: bigint | null;
  startAt: number;           // epoch ms
  endAt: number | null;
  timezone: string;
  pacing: 'even' | 'asap';
  targeting: Targeting;
  creatives: CreativeCandidate[];
}

export interface RequestContext {
  requestId: string;
  now: number;
  siteId: string;
  siteCategory: string;
  siteAllowedFormats: string[];
  unitId: string;
  unitFormats: string[];
  unitWidth: number | null;
  unitHeight: number | null;
  unitResponsive: boolean;
  country: string;           // ISO-3166 alpha-2 or 'ZZ' when unknown
  device: string;
  keywords: string[];
  personalized: boolean;
  blockedCountries: string[];
  excludeCampaignIds: string[];
  cpcEnabled: boolean;
  /** Estimated spend today per campaign (micros), from Redis counters. */
  spentToday: (campaignId: string) => bigint;
}

export type RejectReason =
  | 'status' | 'schedule' | 'budget' | 'daily_budget' | 'pacing' | 'country' | 'device' | 'site_category'
  | 'keywords' | 'site_list' | 'unit_list' | 'personalization' | 'no_creative' | 'pricing_disabled' | 'already_on_page' | 'blocked_country';

export interface RankedCandidate { campaign: CampaignCandidate; creative: CreativeCandidate; score: number; tiebreak: string }
export interface DecisionResult { ranked: RankedCandidate[]; rejected: Array<{ campaignId: string; reason: RejectReason }> }

function nonEmptyMiss(list: string[], value: string): boolean {
  return list.length > 0 && !list.includes(value);
}

/** Fraction of the current day elapsed in the campaign's time zone, in [0,1). */
export function dayFraction(now: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(now));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return (get('hour') * 3600 + get('minute') * 60 + get('second')) / 86400;
  } catch {
    const d = new Date(now);
    return (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()) / 86400;
  }
}

/** Effective daily budget: explicit daily budget or, for even pacing with an end date, remaining budget spread over remaining days. */
export function effectiveDailyBudget(c: CampaignCandidate, now: number): bigint | null {
  if (c.dailyBudgetMicros !== null) return c.dailyBudgetMicros;
  if (c.pacing === 'even' && c.endAt !== null) {
    const remaining = c.lifetimeBudgetMicros - c.spentMicros;
    const daysLeft = Math.max(1, Math.ceil((c.endAt - now) / 86_400_000));
    return remaining / BigInt(daysLeft);
  }
  return null;
}

/** Estimated cost of one delivery used for budget pre-checks. CPC uses the click price as a conservative upper bound. */
export function unitCostMicros(c: Pick<CampaignCandidate, 'pricingModel' | 'rateMicros'>): bigint {
  if (c.pricingModel === 'cpm') return c.rateMicros / 1000n;
  if (c.pricingModel === 'cpc') return c.rateMicros;
  return 0n; // flat-rate sponsorships are charged by settlement, not per delivery
}

export function pacingAllows(c: CampaignCandidate, spentToday: bigint, now: number): { ok: boolean; ratio: number; reason?: RejectReason } {
  const daily = effectiveDailyBudget(c, now);
  if (daily === null || daily <= 0n) return { ok: true, ratio: 0 };
  const cost = unitCostMicros(c);
  if (spentToday + cost > daily) return { ok: false, ratio: 1, reason: 'daily_budget' };
  if (c.pacing === 'asap') return { ok: true, ratio: Number(spentToday) / Number(daily) };
  // Even pacing: allow spend up to the elapsed share of the day plus one hour of slack.
  const allowedFraction = Math.min(1, dayFraction(now, c.timezone) + 1 / 24);
  const allowed = (daily * BigInt(Math.round(allowedFraction * 10_000))) / 10_000n;
  const ratio = Number(spentToday) / Math.max(1, Number(allowed));
  if (spentToday + cost > allowed) return { ok: false, ratio, reason: 'pacing' };
  return { ok: true, ratio };
}

function creativeFits(cr: CreativeCandidate, ctx: RequestContext): boolean {
  if (!ctx.unitFormats.includes(cr.format) || !ctx.siteAllowedFormats.includes(cr.format)) return false;
  if (cr.format === 'text') return true;
  if (!cr.width || !cr.height) return false;
  if (ctx.unitWidth && ctx.unitHeight) {
    if (cr.width === ctx.unitWidth && cr.height === ctx.unitHeight) return true;
    // Responsive units accept creatives that scale down without changing aspect ratio by more than 5%.
    if (!ctx.unitResponsive) return false;
    const a = cr.width / cr.height;
    const b = ctx.unitWidth / ctx.unitHeight;
    return Math.abs(a - b) / b <= 0.05;
  }
  return true;
}

function hash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

/** Expected value per delivery in micros, used only for ordering within a priority tier. */
function expectedValue(c: CampaignCandidate): number {
  if (c.pricingModel === 'cpm') return Number(c.rateMicros) / 1000;
  if (c.pricingModel === 'cpc') return (Number(c.rateMicros) * 0.002); // conservative 0.2% CTR assumption
  return Number.MAX_SAFE_INTEGER / 4; // sponsorships win their tier
}

export function decide(candidates: CampaignCandidate[], ctx: RequestContext): DecisionResult {
  const ranked: RankedCandidate[] = [];
  const rejected: DecisionResult['rejected'] = [];
  const reject = (c: CampaignCandidate, reason: RejectReason) => rejected.push({ campaignId: c.id, reason });

  for (const c of candidates) {
    const t = c.targeting;
    if (c.status !== 'active' && c.status !== 'scheduled') { reject(c, 'status'); continue; }
    if (ctx.now < c.startAt || (c.endAt !== null && ctx.now >= c.endAt)) { reject(c, 'schedule'); continue; }
    if (c.pricingModel === 'cpc' && !ctx.cpcEnabled) { reject(c, 'pricing_disabled'); continue; }
    if (ctx.excludeCampaignIds.includes(c.id)) { reject(c, 'already_on_page'); continue; }
    const cost = unitCostMicros(c);
    if (c.spentMicros + cost > c.lifetimeBudgetMicros || c.spentMicros >= c.lifetimeBudgetMicros) { reject(c, 'budget'); continue; }
    if (ctx.blockedCountries.includes(ctx.country)) { reject(c, 'blocked_country'); continue; }
    if (nonEmptyMiss(t.countries, ctx.country)) { reject(c, 'country'); continue; }
    if (nonEmptyMiss(t.devices, ctx.device)) { reject(c, 'device'); continue; }
    if (nonEmptyMiss(t.siteCategories, ctx.siteCategory)) { reject(c, 'site_category'); continue; }
    if (t.excludeSiteIds.includes(ctx.siteId) || nonEmptyMiss(t.includeSiteIds, ctx.siteId)) { reject(c, 'site_list'); continue; }
    if (t.excludeUnitIds.includes(ctx.unitId) || nonEmptyMiss(t.includeUnitIds, ctx.unitId)) { reject(c, 'unit_list'); continue; }
    if (t.requirePersonalized && !ctx.personalized) { reject(c, 'personalization'); continue; }
    if (t.keywords.length > 0) {
      const kw = new Set(ctx.keywords.map((k) => k.toLowerCase()));
      if (!t.keywords.some((k) => kw.has(k.toLowerCase()))) { reject(c, 'keywords'); continue; }
    }
    const pacing = pacingAllows(c, ctx.spentToday(c.id), ctx.now);
    if (!pacing.ok) { reject(c, pacing.reason ?? 'pacing'); continue; }
    const fitting = c.creatives.filter((cr) => creativeFits(cr, ctx)).sort((a, b) => a.id.localeCompare(b.id));
    if (fitting.length === 0) { reject(c, 'no_creative'); continue; }
    // Even creative rotation, deterministic for a given request.
    const pick = parseInt(hash(`${ctx.requestId}:${c.id}:creative`), 16) % fitting.length;
    const creative = fitting[pick]!;
    // Priority dominates; within a tier, value then under-delivered campaigns first.
    const score = c.priority * 1e15 + Math.min(expectedValue(c), 1e14) * (1 - Math.min(pacing.ratio, 1) * 0.5);
    ranked.push({ campaign: c, creative, score, tiebreak: hash(`${ctx.requestId}:${c.id}`) });
  }
  ranked.sort((a, b) => b.score - a.score || a.tiebreak.localeCompare(b.tiebreak));
  return { ranked, rejected };
}
