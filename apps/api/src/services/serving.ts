import { randomUUID } from 'node:crypto';
import { decide, unitCostMicros, type CampaignCandidate, type CreativeCandidate } from '@blissnova/ad-decision';
import type { PlatformSettings } from '@blissnova/shared';
import { deviceCategory, hostAuthorized, isKnownCrawler, normalizeHost, signDeliveryToken, visitorHash, type DeliveryClaims } from '@blissnova/tracking';
import type { AppContext } from '../lib/context';

/**
 * Ad-serving runtime. Holds an in-memory snapshot of approved inventory and
 * eligible campaigns (refreshed every few seconds or when invalidated through
 * Redis), so a decision needs no Postgres round trip. Concurrency-sensitive
 * state (frequency caps, spend estimates) lives in Redis and is updated with
 * atomic Lua scripts. The authoritative budget check happens again, in a
 * Postgres transaction, when an impression or click becomes billable.
 */
export interface SiteSnap { id: string; orgId: string; domain: string; allowedDomains: string[]; category: string; allowedFormats: string[]; revenueShareBps: number; blockedCategories: string[] }
export interface UnitSnap { id: string; siteId: string; key: string; formats: string[]; width: number | null; height: number | null; responsive: boolean }
export interface CreativeSnap extends CreativeCandidate { snapshot: { headline?: string; body?: string; cta?: string; storageKey?: string | null; altText?: string; displayUrl?: string; destinationUrl: string } }
export interface CampaignSnap extends CampaignCandidate { caps: Array<{ scope: 'visitor' | 'page'; max: number; window: number }>; orgCaps: Array<{ max: number; window: number }>; creatives: CreativeSnap[] }

interface Snapshot { at: number; version: string; sites: Map<string, SiteSnap>; units: Map<string, UnitSnap>; campaigns: CampaignSnap[]; blockedCountries: string[]; defaultShareBps: number }

let snapshot: Snapshot | null = null;
let loading: Promise<Snapshot> | null = null;
let lastVersionCheck = 0;
const SNAPSHOT_TTL_MS = 15_000;

export function invalidateServingCache(ctx: Pick<AppContext, 'redis'>) {
  snapshot = null;
  void ctx.redis.incr('serving:version').catch(() => undefined);
}

async function loadSnapshot(ctx: AppContext): Promise<Snapshot> {
  const s = await ctx.settings.get();
  const version = (await ctx.redis.get('serving:version')) ?? '0';
  const sites = new Map<string, SiteSnap>();
  const siteRows = (await ctx.db.query(
    `SELECT s.*, o.revenue_share_bps AS org_share FROM sites s JOIN organizations o ON o.id = s.org_id
     WHERE s.status = 'approved' AND o.status = 'approved' AND (s.verified_at IS NOT NULL OR NOT $1::boolean)`, [s.publishers.requireDomainVerification])).rows;
  for (const r of siteRows) {
    sites.set(r.public_key, { id: r.id, orgId: r.org_id, domain: r.domain, allowedDomains: r.allowed_domains, category: r.category, allowedFormats: r.allowed_formats, revenueShareBps: r.revenue_share_bps ?? r.org_share ?? s.publishers.defaultRevenueShareBps, blockedCategories: r.blocked_categories });
  }
  const units = new Map<string, UnitSnap>();
  const unitRows = (await ctx.db.query(`SELECT u.* FROM ad_units u JOIN sites s ON s.id = u.site_id WHERE u.status = 'active' AND NOT u.admin_blocked AND s.status = 'approved'`)).rows;
  for (const u of unitRows) units.set(`${u.site_id}:${u.key}`, { id: u.id, siteId: u.site_id, key: u.key, formats: u.formats, width: u.width, height: u.height, responsive: u.responsive });

  const camps = (await ctx.db.query(
    `SELECT c.*, t.countries, t.devices, t.site_categories, t.keywords, t.include_site_ids, t.exclude_site_ids, t.include_unit_ids, t.exclude_unit_ids, t.require_personalized
     FROM campaigns c JOIN organizations o ON o.id = c.org_id LEFT JOIN campaign_targeting t ON t.campaign_id = c.id
     WHERE c.status IN ('active', 'scheduled') AND o.status = 'approved' AND c.spent_micros < c.lifetime_budget_micros AND (c.end_at IS NULL OR c.end_at > now())`)).rows;
  const ids = camps.map((c) => c.id);
  const creatives = ids.length ? (await ctx.db.query(
    `SELECT cr.id, cr.campaign_id, cr.format, v.snapshot FROM creatives cr JOIN creative_versions v ON v.creative_id = cr.id AND v.version = cr.approved_version
     WHERE cr.campaign_id = ANY($1) AND cr.approved_version IS NOT NULL AND cr.status <> 'archived'`, [ids])).rows : [];
  const caps = ids.length ? (await ctx.db.query('SELECT campaign_id, scope, max_impressions, window_seconds FROM campaign_caps WHERE campaign_id = ANY($1)', [ids])).rows : [];
  const orgCaps = ids.length ? (await ctx.db.query('SELECT org_id, max_impressions, window_seconds FROM advertiser_caps WHERE org_id = ANY($1)', [[...new Set(camps.map((c) => c.org_id))]])).rows : [];
  const blockedCountries = (await ctx.db.query<{ value: string }>(`SELECT value FROM inventory_rules WHERE kind = 'blocked_country'`)).rows.map((r) => r.value);
  const blockedKeywords = new Set((await ctx.db.query<{ value: string }>(`SELECT value FROM inventory_rules WHERE kind = 'blocked_keyword'`)).rows.map((r) => r.value.toLowerCase()));

  const campaigns: CampaignSnap[] = camps
    .filter((c) => !(c.keywords ?? []).some((k: string) => blockedKeywords.has(k)))
    .map((c) => ({
      id: c.id, orgId: c.org_id, status: c.status, priority: Math.max(1, Math.min(15, c.priority + c.admin_priority_boost)), pricingModel: c.pricing_model,
      rateMicros: BigInt(c.rate_micros), currency: c.currency, lifetimeBudgetMicros: BigInt(c.lifetime_budget_micros), spentMicros: BigInt(c.spent_micros),
      dailyBudgetMicros: c.daily_budget_micros ? BigInt(c.daily_budget_micros) : null, startAt: new Date(c.start_at).getTime(), endAt: c.end_at ? new Date(c.end_at).getTime() : null,
      timezone: c.timezone, pacing: c.pacing,
      targeting: {
        countries: c.countries ?? [], devices: c.devices ?? [], siteCategories: c.site_categories ?? [], keywords: c.keywords ?? [], includeSiteIds: c.include_site_ids ?? [],
        excludeSiteIds: c.exclude_site_ids ?? [], includeUnitIds: c.include_unit_ids ?? [], excludeUnitIds: c.exclude_unit_ids ?? [], requirePersonalized: c.require_personalized ?? false,
      },
      creatives: creatives.filter((cr) => cr.campaign_id === c.id).map((cr) => ({ id: cr.id, format: cr.format, width: cr.snapshot.width ?? null, height: cr.snapshot.height ?? null, snapshot: cr.snapshot })),
      caps: caps.filter((x) => x.campaign_id === c.id).map((x) => ({ scope: x.scope, max: x.max_impressions, window: x.window_seconds })),
      orgCaps: orgCaps.filter((x) => x.org_id === c.org_id).map((x) => ({ max: x.max_impressions, window: x.window_seconds })),
    }));
  return { at: Date.now(), version, sites, units, campaigns, blockedCountries, defaultShareBps: s.publishers.defaultRevenueShareBps };
}

export async function getSnapshot(ctx: AppContext): Promise<Snapshot> {
  const now = Date.now();
  if (snapshot && now - snapshot.at < SNAPSHOT_TTL_MS) {
    if (now - lastVersionCheck > 1000) {
      lastVersionCheck = now;
      const v = (await ctx.redis.get('serving:version')) ?? '0';
      if (v === snapshot.version) return snapshot;
    } else {
      return snapshot;
    }
  }
  loading ??= loadSnapshot(ctx).then((s) => { snapshot = s; return s; }).finally(() => { loading = null; });
  return loading;
}

/** Calendar day (YYYY-MM-DD) in a time zone; used for daily budgets. */
export function dayInZone(now: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

// Atomically check every cap counter, then increment all of them; refuses (0) if any is at its limit.
const CAP_SCRIPT = `
for i = 1, #KEYS do
  local n = tonumber(redis.call('GET', KEYS[i]) or '0')
  if n >= tonumber(ARGV[i * 2 - 1]) then return 0 end
end
for i = 1, #KEYS do
  local n = redis.call('INCR', KEYS[i])
  if n == 1 then redis.call('EXPIRE', KEYS[i], ARGV[i * 2]) end
end
return 1
`;

export async function reserveCaps(ctx: Pick<AppContext, 'redis'>, keys: string[], limits: Array<{ max: number; window: number }>): Promise<boolean> {
  if (keys.length === 0) return true;
  const args = limits.flatMap((l) => [String(l.max), String(l.window)]);
  return (await ctx.redis.eval(CAP_SCRIPT, keys.length, ...keys, ...args)) === 1;
}

export interface ServeRequest {
  siteKey: string;
  units: Array<{ slot: string }>;
  page: { url: string; keywords?: string[] };
  consent?: { personalized?: boolean; gdprApplies?: boolean };
  vid?: string;
  pv: string;
}
export interface ServeMeta { ip: string; ipHash: string; ua: string; origin: string | null; country: string; requestId: string }
export interface ServedAd {
  slot: string;
  ad: null | { format: 'image' | 'text'; token: string; clickUrl: string; width: number | null; height: number | null; image?: { url: string; alt: string }; text?: { headline: string; body: string; cta: string; displayUrl: string } };
}
export interface ServeLog { deliveries: Array<{ claims: DeliveryClaims; ipHash: string; uaHash: string | null }>; counters: Array<{ unitId: string; field: 'requests' | 'filled' | 'no_fill' | 'cap_rejects' | 'budget_rejects' | 'blocked' }>; day: string }

export type ServeOutcome = { status: 'ok' | 'inactive' | 'blocked' | 'disabled'; ads: ServedAd[]; log: ServeLog | null };

export async function serveAds(ctx: AppContext, req: ServeRequest, meta: ServeMeta, settings: PlatformSettings): Promise<ServeOutcome> {
  const empty = (status: ServeOutcome['status']): ServeOutcome => ({ status, ads: req.units.map((u) => ({ slot: u.slot, ad: null })), log: null });
  if (!settings.tracking.enabled || !settings.tracking.impressions) return empty('disabled');
  const snap = await getSnapshot(ctx);
  const site = snap.sites.get(req.siteKey);
  if (!site) return empty('inactive');

  const day = new Date().toISOString().slice(0, 10);
  const log: ServeLog = { deliveries: [], counters: [], day };
  let pageHost: string;
  try {
    pageHost = normalizeHost(new URL(req.page.url).hostname);
  } catch {
    return empty('blocked');
  }
  const originHost = meta.origin ? (() => { try { return normalizeHost(new URL(meta.origin!).hostname); } catch { return ''; } })() : null;
  const domainOk = hostAuthorized(pageHost, site.domain, site.allowedDomains) && (originHost === null || hostAuthorized(originHost, site.domain, site.allowedDomains));
  const units = req.units.map((u) => ({ slot: u.slot, unit: snap.units.get(`${site.id}:${u.slot}`) }));
  if (!domainOk || isKnownCrawler(meta.ua)) {
    for (const u of units) if (u.unit) log.counters.push({ unitId: u.unit.id, field: 'requests' }, { unitId: u.unit.id, field: 'blocked' });
    return { ...empty('blocked'), log };
  }

  const personalized = Boolean(req.consent?.personalized && settings.tracking.personalizedAllowed && req.vid && /^[A-Za-z0-9_-]{16,64}$/.test(req.vid));
  const vHash = personalized ? visitorHash(ctx.config.APP_SECRET, req.vid!) : undefined;
  const device = deviceCategory(meta.ua);
  const keywords = (req.page.keywords ?? []).map((k) => k.toLowerCase().slice(0, 60)).slice(0, 20);
  const now = Date.now();
  const used: string[] = [];
  const ads: ServedAd[] = [];

  for (const { slot, unit } of units) {
    if (!unit) { ads.push({ slot, ad: null }); continue; }
    log.counters.push({ unitId: unit.id, field: 'requests' });
    const spentCache = new Map<string, bigint>();
    const candidates = snap.campaigns;
    // Pre-load today's spend estimates for the candidates in one round trip.
    const keys = candidates.map((c) => `spend:${c.id}:${dayInZone(now, c.timezone)}`);
    const vals = keys.length ? await ctx.redis.mget(...keys) : [];
    candidates.forEach((c, i) => spentCache.set(c.id, BigInt(vals[i] ?? '0')));
    const result = decide(candidates, {
      requestId: `${meta.requestId}:${slot}`, now, siteId: site.id, siteCategory: site.category, siteAllowedFormats: site.allowedFormats, unitId: unit.id,
      unitFormats: unit.formats, unitWidth: unit.width, unitHeight: unit.height, unitResponsive: unit.responsive, country: meta.country, device, keywords,
      personalized, blockedCountries: snap.blockedCountries, excludeCampaignIds: used, cpcEnabled: settings.pricing.cpcEnabled,
      spentToday: (id) => spentCache.get(id) ?? 0n,
    });
    let chosen: (typeof result.ranked)[number] | null = null;
    let capRejected = false;
    for (const cand of result.ranked) {
      const c = cand.campaign as CampaignSnap;
      const capKeys: string[] = [];
      const limits: Array<{ max: number; window: number }> = [];
      // Page-level cap: campaign-specific or the network default.
      const pageCap = c.caps.find((x) => x.scope === 'page') ?? (settings.frequency.defaultMaxPerPage > 0 ? { scope: 'page' as const, max: settings.frequency.defaultMaxPerPage, window: 1800 } : null);
      if (pageCap) { capKeys.push(`fc:p:${req.pv.slice(0, 40)}:${c.id}`); limits.push({ max: pageCap.max, window: pageCap.window }); }
      if (vHash) {
        for (const cap of c.caps.filter((x) => x.scope === 'visitor')) { capKeys.push(`fc:v:${vHash}:${c.id}:${cap.window}`); limits.push({ max: cap.max, window: cap.window }); }
        for (const cap of c.orgCaps) { capKeys.push(`fc:a:${vHash}:${c.orgId}:${cap.window}`); limits.push({ max: cap.max, window: cap.window }); }
        if (settings.frequency.defaultMaxPerVisitorPerDay > 0 && !c.caps.some((x) => x.scope === 'visitor')) { capKeys.push(`fc:v:${vHash}:${c.id}:86400`); limits.push({ max: settings.frequency.defaultMaxPerVisitorPerDay, window: 86400 }); }
      }
      if (await reserveCaps(ctx, capKeys, limits)) {
        chosen = cand;
        break;
      }
      capRejected = true;
    }
    if (!chosen) {
      const budgetRejected = result.rejected.some((r) => r.reason === 'budget' || r.reason === 'daily_budget' || r.reason === 'pacing');
      log.counters.push({ unitId: unit.id, field: capRejected ? 'cap_rejects' : budgetRejected ? 'budget_rejects' : 'no_fill' });
      ads.push({ slot, ad: null });
      continue;
    }
    const c = chosen.campaign as CampaignSnap;
    const cr = chosen.creative as CreativeSnap;
    used.push(c.id);
    const cost = unitCostMicros(c);
    if (cost > 0n) await ctx.redis.multi().incrby(`spend:${c.id}:${dayInZone(now, c.timezone)}`, Number(cost)).expire(`spend:${c.id}:${dayInZone(now, c.timezone)}`, 3 * 86400).exec();
    const claims: DeliveryClaims = {
      d: randomUUID(), c: c.id, cr: cr.id, ao: c.orgId, s: site.id, u: unit.id, po: site.orgId, pm: c.pricingModel, r: c.rateMicros.toString(), cur: c.currency,
      sh: site.revenueShareBps, ph: pageHost, co: meta.country, dv: device, ct: !personalized, v: vHash, iat: now, exp: now + settings.tracking.tokenTtlSeconds * 1000,
    };
    const token = signDeliveryToken(ctx.tokens, claims);
    log.deliveries.push({ claims, ipHash: meta.ipHash, uaHash: null });
    log.counters.push({ unitId: unit.id, field: 'filled' });
    const snapC = cr.snapshot;
    ads.push({
      slot,
      ad: {
        format: cr.format, token, clickUrl: `${ctx.config.PUBLIC_API_URL}/api/v1/click?t=${encodeURIComponent(token)}`, width: cr.width, height: cr.height,
        ...(cr.format === 'image' && snapC.storageKey ? { image: { url: ctx.storage.publicUrl(snapC.storageKey), alt: snapC.altText ?? snapC.headline ?? 'Advertisement' } } : {}),
        ...(cr.format === 'text' ? { text: { headline: snapC.headline ?? '', body: snapC.body ?? '', cta: snapC.cta ?? '', displayUrl: snapC.displayUrl ?? hostOf(snapC.destinationUrl) } } : {}),
      },
    });
  }
  return { status: 'ok', ads, log };
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Persist served deliveries and request counters (called by the worker, or inline). Idempotent per delivery id. */
export async function writeServeLog(db: AppContext['db'], log: ServeLog) {
  for (const d of log.deliveries) {
    const c = d.claims;
    await db.query(
      `INSERT INTO ad_events (event_key, delivery_id, type, status, campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id, visitor_hash, ip_hash, country, device, contextual, page_host, currency, occurred_at)
       VALUES ($1, $2, 'served', 'valid', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, to_timestamp($16 / 1000.0))
       ON CONFLICT DO NOTHING`,
      [`${c.d}:served`, c.d, c.c, c.cr, c.ao, c.s, c.u, c.po, c.v ?? null, d.ipHash, c.co, c.dv, c.ct, c.ph, c.cur, c.iat]);
  }
  const agg = new Map<string, Record<string, number>>();
  for (const k of log.counters) {
    const m = agg.get(k.unitId) ?? {};
    m[k.field] = (m[k.field] ?? 0) + 1;
    agg.set(k.unitId, m);
  }
  for (const [unitId, m] of agg) {
    await db.query(
      `INSERT INTO unit_request_stats (day, unit_id, requests, filled, no_fill, cap_rejects, budget_rejects, blocked) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (day, unit_id) DO UPDATE SET requests = unit_request_stats.requests + EXCLUDED.requests, filled = unit_request_stats.filled + EXCLUDED.filled,
         no_fill = unit_request_stats.no_fill + EXCLUDED.no_fill, cap_rejects = unit_request_stats.cap_rejects + EXCLUDED.cap_rejects,
         budget_rejects = unit_request_stats.budget_rejects + EXCLUDED.budget_rejects, blocked = unit_request_stats.blocked + EXCLUDED.blocked`,
      [log.day, unitId, m.requests ?? 0, m.filled ?? 0, m.no_fill ?? 0, m.cap_rejects ?? 0, m.budget_rejects ?? 0, m.blocked ?? 0]);
  }
}

