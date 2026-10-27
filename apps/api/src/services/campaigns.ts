import type { PoolClient } from 'pg';
import { z } from 'zod';
import { formatMicros, toMicros, type PlatformSettings } from '@blissnova/shared';
import { badRequest } from '../lib/errors';
import { moneyString } from '../lib/http';

const targetingSchema = z.object({
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(250).default([]),
  devices: z.array(z.enum(['desktop', 'mobile', 'tablet', 'other'])).max(4).default([]),
  siteCategories: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
  keywords: z.array(z.string().trim().min(1).max(60)).max(100).default([]),
  includeSiteIds: z.array(z.uuid()).max(500).default([]),
  excludeSiteIds: z.array(z.uuid()).max(500).default([]),
  includeUnitIds: z.array(z.uuid()).max(500).default([]),
  excludeUnitIds: z.array(z.uuid()).max(500).default([]),
  requirePersonalized: z.boolean().default(false),
});
const capSchema = z.object({ scope: z.enum(['visitor', 'page']), maxImpressions: z.number().int().min(1).max(10000), windowSeconds: z.number().int().min(60).max(2_592_000) });

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const campaignBody = z.object({
  name: z.string().trim().min(1).max(160),
  pricingModel: z.enum(['cpm', 'cpc', 'flat']),
  rate: moneyString,
  lifetimeBudget: moneyString,
  dailyBudget: moneyString.nullable().optional(),
  maxImpressions: z.number().int().positive().nullable().optional(),
  maxClicks: z.number().int().positive().nullable().optional(),
  timezone: z.string().max(64).refine(isTimeZone, 'Unknown time zone').default('UTC'),
  startAt: z.iso.datetime({ offset: true }),
  endAt: z.iso.datetime({ offset: true }).nullable().optional(),
  pacing: z.enum(['even', 'asap']).default('even'),
  priority: z.number().int().min(1).max(10).default(5),
  targeting: targetingSchema.prefault({}),
  caps: z.array(capSchema).max(5).default([]),
});
export const campaignPatch = campaignBody.partial();
export type CampaignInput = z.infer<typeof campaignBody>;

export function validateCampaignRules(input: CampaignInput, s: PlatformSettings) {
  const rate = toMicros(input.rate);
  const lifetime = toMicros(input.lifetimeBudget);
  const daily = input.dailyBudget ? toMicros(input.dailyBudget) : null;
  if (input.pricingModel === 'cpm' && !s.pricing.cpmEnabled) throw badRequest('CPM pricing is not currently available');
  if (input.pricingModel === 'cpc' && !s.pricing.cpcEnabled) throw badRequest('CPC pricing is not currently available');
  if (input.pricingModel === 'flat' && !s.pricing.flatEnabled) throw badRequest('Flat-rate pricing is not currently available');
  if (input.pricingModel === 'cpm' && rate < BigInt(s.pricing.minCpmMicros)) throw badRequest(`Minimum CPM is ${formatMicros(s.pricing.minCpmMicros)}`);
  if (input.pricingModel === 'cpc' && rate < BigInt(s.pricing.minCpcMicros)) throw badRequest(`Minimum CPC is ${formatMicros(s.pricing.minCpcMicros)}`);
  if (input.pricingModel === 'cpm' && rate % 1000n !== 0n) throw badRequest('CPM rate must be divisible into whole micros per impression (at most 3 decimal places)');
  if (input.pricingModel === 'flat') {
    if (lifetime !== rate) throw badRequest('For flat-rate sponsorships the lifetime budget equals the sponsorship price');
    if (!input.endAt) throw badRequest('Flat-rate sponsorships need an end date');
    if (input.targeting.includeUnitIds.length === 0 && input.targeting.includeSiteIds.length === 0) throw badRequest('Flat-rate sponsorships must name the sites or placements they sponsor');
  }
  if (lifetime < BigInt(s.pricing.minCampaignBudgetMicros)) throw badRequest(`Minimum campaign budget is ${formatMicros(s.pricing.minCampaignBudgetMicros)}`);
  if (daily !== null && daily > lifetime) throw badRequest('Daily budget cannot exceed the lifetime budget');
  if (input.endAt && Date.parse(input.endAt) <= Date.parse(input.startAt)) throw badRequest('End date must be after the start date');
  const overlap = input.targeting.includeSiteIds.filter((id) => input.targeting.excludeSiteIds.includes(id));
  if (overlap.length) throw badRequest('A site cannot be both included and excluded');
  return { rate, lifetime, daily };
}

export async function writeTargetingAndCaps(client: PoolClient, campaignId: string, input: Pick<CampaignInput, 'targeting' | 'caps'>) {
  const t = input.targeting;
  await client.query(
    `INSERT INTO campaign_targeting (campaign_id, countries, devices, site_categories, keywords, include_site_ids, exclude_site_ids, include_unit_ids, exclude_unit_ids, require_personalized)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (campaign_id) DO UPDATE SET countries = EXCLUDED.countries, devices = EXCLUDED.devices, site_categories = EXCLUDED.site_categories, keywords = EXCLUDED.keywords,
       include_site_ids = EXCLUDED.include_site_ids, exclude_site_ids = EXCLUDED.exclude_site_ids, include_unit_ids = EXCLUDED.include_unit_ids, exclude_unit_ids = EXCLUDED.exclude_unit_ids, require_personalized = EXCLUDED.require_personalized`,
    [campaignId, t.countries, t.devices, t.siteCategories.map((c) => c.toLowerCase()), t.keywords.map((k) => k.toLowerCase()), t.includeSiteIds, t.excludeSiteIds, t.includeUnitIds, t.excludeUnitIds, t.requirePersonalized],
  );
  await client.query('DELETE FROM campaign_caps WHERE campaign_id = $1', [campaignId]);
  for (const c of input.caps) {
    await client.query('INSERT INTO campaign_caps (campaign_id, scope, max_impressions, window_seconds) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [campaignId, c.scope, c.maxImpressions, c.windowSeconds]);
  }
}

export async function loadCampaign(db: { query: PoolClient['query'] }, id: string, orgId?: string) {
  const c = (await db.query(`SELECT * FROM campaigns WHERE id = $1 ${orgId ? 'AND org_id = $2' : ''}`, orgId ? [id, orgId] : [id])).rows[0];
  if (!c) return null;
  const t = (await db.query('SELECT * FROM campaign_targeting WHERE campaign_id = $1', [id])).rows[0];
  const caps = (await db.query('SELECT scope, max_impressions, window_seconds FROM campaign_caps WHERE campaign_id = $1 ORDER BY window_seconds', [id])).rows;
  return serializeCampaign(c, t, caps);
}

export function serializeCampaign(c: Record<string, any>, t?: Record<string, any>, caps: Array<Record<string, any>> = []) {
  return {
    id: c.id, orgId: c.org_id, name: c.name, status: c.status, statusReason: c.status_reason, pricingModel: c.pricing_model,
    rateMicros: c.rate_micros, currency: c.currency, lifetimeBudgetMicros: c.lifetime_budget_micros, dailyBudgetMicros: c.daily_budget_micros,
    spentMicros: c.spent_micros, reservedMicros: c.reserved_micros, remainingMicros: (BigInt(c.lifetime_budget_micros) - BigInt(c.spent_micros)).toString(),
    maxImpressions: c.max_impressions, maxClicks: c.max_clicks, billableImpressions: c.billable_impressions, billableClicks: c.billable_clicks,
    timezone: c.timezone, startAt: c.start_at, endAt: c.end_at, pacing: c.pacing, priority: c.priority, adminPriorityBoost: c.admin_priority_boost,
    version: c.version, submittedAt: c.submitted_at, approvedAt: c.approved_at, createdAt: c.created_at, updatedAt: c.updated_at,
    targeting: t ? {
      countries: t.countries, devices: t.devices, siteCategories: t.site_categories, keywords: t.keywords, includeSiteIds: t.include_site_ids,
      excludeSiteIds: t.exclude_site_ids, includeUnitIds: t.include_unit_ids, excludeUnitIds: t.exclude_unit_ids, requirePersonalized: t.require_personalized,
    } : undefined,
    caps: caps.map((x) => ({ scope: x.scope, maxImpressions: x.max_impressions, windowSeconds: x.window_seconds })),
  };
}

export async function recordHistory(client: { query: PoolClient['query'] }, campaignId: string, actorId: string | null, action: string, before: unknown, after: unknown, reason?: string | null) {
  await client.query('INSERT INTO campaign_history (campaign_id, actor_id, action, before, after, reason) VALUES ($1, $2, $3, $4, $5, $6)',
    [campaignId, actorId, action, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), reason ?? null]);
}

/** Status to use once a campaign is approved/resumed: scheduled until its start time. */
export function liveStatus(startAt: Date | string, now = new Date()): 'active' | 'scheduled' {
  return new Date(startAt).getTime() > now.getTime() ? 'scheduled' : 'active';
}
