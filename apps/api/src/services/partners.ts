import type { Pool, PoolClient } from 'pg';
import type { Redis } from 'ioredis';
import { chargePartnerDay } from '@blissnova/billing';
import { withTransaction } from '@blissnova/database';
import type { AppConfig } from '../config';
import { SimulatedPartnerAdapter } from './partner-simulator';

/**
 * Partner networks: BlissNova runs part of an advertiser's CPC campaign on an
 * outside native network (MGID, Revcontent, Taboola, Outbrain/Teads) from its
 * own agency account there. Each network is an adapter; the worker syncs
 * every partner campaign once a minute: create it when the campaign goes live,
 * send BlissNova-approved native ads, read the partner's own review result,
 * pull delivery and cost, charge the advertiser cost plus markup, and push
 * budget caps and pause/stop so the partner never spends past what the
 * campaign has left.
 *
 * Only the development simulator exists today. Real adapters need a signed
 * partner account and API access, and read their credentials from the
 * environment, never from the database.
 */
export type PartnerState = 'active' | 'paused' | 'stopped';

export interface PartnerCampaignSpec {
  /** BlissNova's partner campaign id, so a partner-side record can be traced back. */
  reference: string;
  name: string;
  currency: string;
  countries: string[];
  devices: string[];
  startAt: string;
  endAt: string | null;
}
/** Amounts in the partner's terms (BlissNova's cost, before markup). */
export interface PartnerBudget { cpcMicros: bigint; totalMicros: bigint; dailyMicros: bigint | null }
export interface PartnerAdSpec { creativeId: string; version: number; headline: string; body: string | null; cta: string | null; sponsorName: string | null; imageUrl: string | null; destinationUrl: string }
export interface PartnerAdStatus { externalId: string; status: 'in_review' | 'approved' | 'rejected'; reason?: string }
export interface PartnerDayStats { day: string; impressions: number; clicks: number; conversions: number; costMicros: bigint }

export interface PartnerAdapter {
  readonly id: string;
  readonly devOnly: boolean;
  status(): { configured: boolean; detail: string };
  testConnection(): Promise<{ ok: boolean; detail: string }>;
  createCampaign(spec: PartnerCampaignSpec, budget: PartnerBudget): Promise<{ externalId: string }>;
  updateBudget(externalId: string, budget: PartnerBudget): Promise<void>;
  setState(externalId: string, state: PartnerState): Promise<void>;
  submitAds(externalId: string, ads: PartnerAdSpec[]): Promise<Array<{ creativeId: string; externalId: string }>>;
  fetchStatus(externalId: string): Promise<{ ads: PartnerAdStatus[] }>;
  /** Cumulative delivery per UTC day, as the partner reports it. */
  fetchStats(externalId: string, fromDay: string, toDay: string): Promise<PartnerDayStats[]>;
}

/** What each real network needs before its adapter can be built and switched on. */
export const PARTNER_REQUIREMENTS: Record<string, string> = {
  mgid: 'Needs a BlissNova agency (Super Client) account at MGID and its API token.',
  revcontent: 'Needs a BlissNova advertiser account at Revcontent and its API credentials.',
  taboola: 'Needs a Taboola network account and approved Backstage API access.',
  outbrain: 'Needs approved Amplify API access from Outbrain (Teads).',
};

export class PartnerRegistry {
  private adapters = new Map<string, PartnerAdapter>();
  constructor(cfg: AppConfig, redis: Redis, opts: { now?: () => number; reviewMs?: number } = {}) {
    if (cfg.ENABLE_DEV_PARTNER_SIMULATOR && !cfg.isProd) this.register(new SimulatedPartnerAdapter(redis, opts.now, { reviewMs: opts.reviewMs }));
  }
  register(a: PartnerAdapter) {
    this.adapters.set(a.id, a);
  }
  get(id: string): PartnerAdapter | undefined {
    return this.adapters.get(id);
  }
  /** Connection state shown to staff. */
  describe(id: string): { available: boolean; detail: string } {
    const a = this.adapters.get(id);
    if (a) return { available: a.status().configured, detail: a.status().detail };
    return { available: false, detail: PARTNER_REQUIREMENTS[id] ?? 'Not connected.' };
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const big = (v: unknown) => BigInt((v as string | number | null | undefined) ?? 0);
const toCost = (charged: bigint, markupBps: number) => (charged * 10_000n) / BigInt(10_000 + markupBps);
const TERMINAL = new Set(['completed', 'archived', 'rejected']);

/**
 * Caps pushed to the partner, in its terms. The total cap is what the partner
 * has already spent plus what the campaign can still pay for (its remaining
 * budget, and this partner's share of the lifetime budget), converted from
 * advertiser price to partner cost.
 */
export function partnerBudget(c: { rate_micros: string; lifetime_budget_micros: string; reserved_micros: string; spent_micros: string; daily_budget_micros: string | null }, pc: { budget_share_bps: number; markup_bps: number; cost_micros: string; charged_micros: string }): PartnerBudget {
  const lifetime = big(c.lifetime_budget_micros);
  const ceiling = lifetime < big(c.reserved_micros) ? lifetime : big(c.reserved_micros);
  const remaining = ceiling - big(c.spent_micros);
  const share = (lifetime * BigInt(pc.budget_share_bps)) / 10_000n - big(pc.charged_micros);
  const allowed = [remaining, share].reduce((a, b) => (a < b ? a : b));
  const totalMicros = big(pc.cost_micros) + (allowed > 0n ? toCost(allowed, pc.markup_bps) : 0n);
  const dailyMicros = c.daily_budget_micros === null ? null : toCost((big(c.daily_budget_micros) * BigInt(pc.budget_share_bps)) / 10_000n, pc.markup_bps);
  return { cpcMicros: toCost(big(c.rate_micros), pc.markup_bps), totalMicros, dailyMicros };
}

interface SyncDeps { db: Pool; partners: PartnerRegistry; publicUrl: (key: string) => string; log: { warn: (o: object, m?: string) => void } }

async function approvedNativeAds(db: Pool | PoolClient, campaignId: string, publicUrl: (key: string) => string): Promise<PartnerAdSpec[]> {
  const rows = (await db.query(
    `SELECT cr.id, cr.approved_version, v.snapshot FROM creatives cr JOIN creative_versions v ON v.creative_id = cr.id AND v.version = cr.approved_version
     WHERE cr.campaign_id = $1 AND cr.format = 'native' AND cr.approved_version IS NOT NULL AND cr.status <> 'archived' ORDER BY cr.created_at`, [campaignId])).rows;
  return rows.map((r) => ({
    creativeId: r.id, version: r.approved_version, headline: r.snapshot.headline, body: r.snapshot.body ?? null, cta: r.snapshot.cta ?? null,
    sponsorName: r.snapshot.sponsorName ?? null, imageUrl: r.snapshot.storageKey ? publicUrl(r.snapshot.storageKey) : null, destinationUrl: r.snapshot.destinationUrl,
  }));
}

/** One sync pass over every partner campaign that is not finished. Errors on one partner campaign never stop the others. */
export async function syncPartnerCampaigns(deps: SyncDeps, opts: { campaignId?: string } = {}) {
  const rows = (await deps.db.query(
    `SELECT pc.id FROM partner_campaigns pc WHERE pc.status NOT IN ('stopped') ${opts.campaignId ? 'AND pc.campaign_id = $1' : ''} ORDER BY pc.created_at`,
    opts.campaignId ? [opts.campaignId] : [])).rows;
  let synced = 0;
  for (const r of rows) {
    try {
      await syncOne(deps, r.id);
      synced++;
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      deps.log.warn({ partnerCampaignId: r.id, err: msg }, 'partner sync failed');
      await deps.db.query(`UPDATE partner_campaigns SET status = 'error', status_reason = $2, last_synced_at = now(), updated_at = now() WHERE id = $1`, [r.id, `Partner network error: ${msg}`]);
    }
  }
  return { synced, total: rows.length };
}

async function syncOne(deps: SyncDeps, id: string) {
  const { db } = deps;
  const load = async () => (await db.query(
    `SELECT pc.*, c.status AS c_status, c.name AS c_name, c.currency, c.rate_micros, c.lifetime_budget_micros, c.reserved_micros, c.spent_micros, c.daily_budget_micros,
            c.start_at, c.end_at, n.enabled AS n_enabled, t.countries, t.devices
     FROM partner_campaigns pc JOIN campaigns c ON c.id = pc.campaign_id JOIN partner_networks n ON n.id = pc.network_id LEFT JOIN campaign_targeting t ON t.campaign_id = c.id
     WHERE pc.id = $1`, [id])).rows[0];
  let pc = await load();
  if (!pc) return;
  const adapter = deps.partners.get(pc.network_id);
  const set = (status: string, reason: string | null) =>
    db.query(`UPDATE partner_campaigns SET status = $2, status_reason = $3, last_synced_at = now(), updated_at = now() WHERE id = $1`, [id, status, reason]);
  if (!adapter) {
    await set(pc.external_id ? 'error' : 'pending', 'This partner network is not connected yet.');
    return;
  }
  const terminal = TERMINAL.has(pc.c_status) || pc.removed_at !== null;
  const hold = pc.admin_hold ? `Held by BlissNova: ${pc.admin_hold_reason ?? 'under review'}` : !pc.n_enabled ? 'BlissNova has turned this partner network off.' : null;

  if (!pc.external_id) {
    if (terminal) return set('stopped', pc.removed_at ? 'Removed by the advertiser.' : 'The campaign ended before it reached the partner network.');
    if (pc.c_status !== 'active' || hold) return set('pending', hold ?? 'Starts on the partner network once the campaign is live.');
    const ads = await approvedNativeAds(db, pc.campaign_id, deps.publicUrl);
    if (!ads.length) return set('pending', 'Add a native ad (image, headline and sponsor name) and get it approved to run on partner networks.');
    const budget = partnerBudget(pc, pc);
    const { externalId } = await adapter.createCampaign(
      { reference: pc.id, name: pc.c_name, currency: pc.currency, countries: pc.countries ?? [], devices: pc.devices ?? [], startAt: new Date(pc.start_at).toISOString(), endAt: pc.end_at ? new Date(pc.end_at).toISOString() : null }, budget);
    await db.query(`UPDATE partner_campaigns SET external_id = $2, pushed_cpc_micros = $3, pushed_total_micros = $4, pushed_daily_micros = $5 WHERE id = $1`,
      [id, externalId, budget.cpcMicros.toString(), budget.totalMicros.toString(), budget.dailyMicros?.toString() ?? null]);
    const sent = await adapter.submitAds(externalId, ads);
    for (const s of sent) {
      const ad = ads.find((a) => a.creativeId === s.creativeId)!;
      await db.query(`INSERT INTO partner_creatives (partner_campaign_id, creative_id, creative_version, external_id, status) VALUES ($1, $2, $3, $4, 'in_review')
                      ON CONFLICT (partner_campaign_id, creative_id) DO UPDATE SET creative_version = EXCLUDED.creative_version, external_id = EXCLUDED.external_id, status = 'in_review', rejection_reason = NULL, updated_at = now()`,
        [id, s.creativeId, ad.version, s.externalId]);
    }
    return set('in_review', 'Waiting for the partner network to review the ads.');
  }

  const ext = pc.external_id as string;
  // 1. Delivery and cost first, so the caps pushed below reflect the latest spend.
  const from = new Date(pc.created_at).toISOString().slice(0, 10);
  for (const d of await adapter.fetchStats(ext, from, today())) {
    await withTransaction(db, (cl) => chargePartnerDay(cl, { partnerCampaignId: id, ...d }));
  }
  // 2. Ads approved by BlissNova since the last pass (new ones, or a newer approved version).
  if (!terminal) {
    const known = new Map((await db.query('SELECT creative_id, creative_version FROM partner_creatives WHERE partner_campaign_id = $1', [id])).rows.map((r) => [r.creative_id, r.creative_version]));
    const fresh = (await approvedNativeAds(db, pc.campaign_id, deps.publicUrl)).filter((a) => known.get(a.creativeId) !== a.version);
    if (fresh.length) {
      for (const s of await adapter.submitAds(ext, fresh)) {
        const ad = fresh.find((a) => a.creativeId === s.creativeId)!;
        await db.query(`INSERT INTO partner_creatives (partner_campaign_id, creative_id, creative_version, external_id, status) VALUES ($1, $2, $3, $4, 'in_review')
                        ON CONFLICT (partner_campaign_id, creative_id) DO UPDATE SET creative_version = EXCLUDED.creative_version, external_id = EXCLUDED.external_id, status = 'in_review', rejection_reason = NULL, updated_at = now()`,
          [id, s.creativeId, ad.version, s.externalId]);
      }
    }
  }
  // 3. The partner's own review of each ad.
  const status = await adapter.fetchStatus(ext);
  for (const a of status.ads) {
    await db.query(`UPDATE partner_creatives SET status = $3, rejection_reason = $4, updated_at = now() WHERE partner_campaign_id = $1 AND external_id = $2 AND status IS DISTINCT FROM $3`,
      [id, a.externalId, a.status, a.status === 'rejected' ? (a.reason ?? 'Rejected by the partner network') : null]);
  }
  const archived = (await db.query(`SELECT pcr.creative_id FROM partner_creatives pcr JOIN creatives cr ON cr.id = pcr.creative_id WHERE pcr.partner_campaign_id = $1 AND cr.status = 'archived' AND pcr.status <> 'removed'`, [id])).rows;
  if (archived.length) await db.query(`UPDATE partner_creatives SET status = 'removed', updated_at = now() WHERE partner_campaign_id = $1 AND creative_id = ANY($2)`, [id, archived.map((r) => r.creative_id)]);

  // 4. Decide where the partner campaign should be, and push caps and state.
  pc = await load();
  const budget = partnerBudget(pc, pc);
  const ads = (await db.query(`SELECT status FROM partner_creatives WHERE partner_campaign_id = $1 AND status <> 'removed'`, [id])).rows.map((r) => r.status as string);
  let next: string;
  let reason: string | null = null;
  if (pc.removed_at) { next = 'stopped'; reason = 'Removed by the advertiser.'; }
  else if (terminal) { next = 'stopped'; reason = `The campaign is ${pc.c_status}.`; }
  else if (hold) { next = 'paused'; reason = hold; }
  else if (pc.c_status !== 'active') { next = 'paused'; reason = `The campaign is ${pc.c_status.replace('_', ' ')}.`; }
  else if (budget.totalMicros - big(pc.cost_micros) < budget.cpcMicros) { next = 'paused'; reason = 'This partner’s share of the budget is used up.'; }
  else if (ads.includes('approved')) next = 'active';
  else if (ads.includes('in_review') || ads.includes('pending')) { next = 'in_review'; reason = 'Waiting for the partner network to review the ads.'; }
  else if (ads.length) { next = 'rejected'; reason = 'The partner network rejected every ad. Add or edit a native ad to try again.'; }
  else { next = 'paused'; reason = 'No native ads are approved for this campaign.'; }

  if (budget.cpcMicros !== big(pc.pushed_cpc_micros) || budget.totalMicros !== big(pc.pushed_total_micros) || (budget.dailyMicros?.toString() ?? null) !== (pc.pushed_daily_micros ?? null)) {
    await adapter.updateBudget(ext, budget);
    await db.query(`UPDATE partner_campaigns SET pushed_cpc_micros = $2, pushed_total_micros = $3, pushed_daily_micros = $4 WHERE id = $1`, [id, budget.cpcMicros.toString(), budget.totalMicros.toString(), budget.dailyMicros?.toString() ?? null]);
  }
  const wanted: PartnerState = next === 'stopped' ? 'stopped' : next === 'active' || next === 'in_review' ? 'active' : 'paused';
  const had: PartnerState = pc.status === 'stopped' ? 'stopped' : pc.status === 'active' || pc.status === 'in_review' || pc.status === 'error' ? 'active' : 'paused';
  if (wanted !== had || pc.status === 'error') await adapter.setState(ext, wanted);
  await set(next, reason);
}

/** Partner distribution of one campaign, as advertisers and staff see it. */
export async function loadPartnerCampaigns(db: Pool | PoolClient, campaignId: string, audience: 'advertiser' | 'admin') {
  const rows = (await db.query(
    `SELECT pc.*, n.name AS network_name FROM partner_campaigns pc JOIN partner_networks n ON n.id = pc.network_id WHERE pc.campaign_id = $1 ORDER BY n.name`, [campaignId])).rows;
  const ads = (await db.query(
    `SELECT pcr.*, cr.name FROM partner_creatives pcr JOIN creatives cr ON cr.id = pcr.creative_id JOIN partner_campaigns pc ON pc.id = pcr.partner_campaign_id WHERE pc.campaign_id = $1 ORDER BY cr.created_at`, [campaignId])).rows;
  return rows.map((r) => ({
    id: r.id, networkId: r.network_id, networkName: r.network_name, budgetPercent: r.budget_share_bps / 100, status: r.status, statusReason: r.status_reason,
    impressions: Number(r.impressions), clicks: Number(r.clicks), spendMicros: r.charged_micros, lastSyncedAt: r.last_synced_at, createdAt: r.created_at,
    ads: ads.filter((a) => a.partner_campaign_id === r.id).map((a) => ({ creativeId: a.creative_id, name: a.name, version: a.creative_version, status: a.status, rejectionReason: a.rejection_reason })),
    ...(audience === 'admin' ? {
      externalId: r.external_id, markupPercent: r.markup_bps / 100, costMicros: r.cost_micros, absorbedMicros: r.absorbed_micros, adminHold: r.admin_hold, adminHoldReason: r.admin_hold_reason,
      pushedCpcMicros: r.pushed_cpc_micros, pushedTotalMicros: r.pushed_total_micros, pushedDailyMicros: r.pushed_daily_micros,
    } : {}),
  }));
}

/**
 * Delivery by source: the BlissNova network itself and each partner network.
 * Partners report impressions, clicks, conversions and cost; BlissNova's own
 * numbers are validated impressions and clicks.
 */
export async function sourceReport(db: Pool, scope: { advertiserOrgId?: string; campaignId?: string }, from: string, to: string, audience: 'advertiser' | 'admin') {
  const own = (await db.query(
    `SELECT COALESCE(sum(valid_impressions), 0)::bigint AS impressions, COALESCE(sum(valid_clicks), 0)::bigint AS clicks, COALESCE(sum(spend_micros), 0)::bigint AS spend
     FROM daily_stats d WHERE d.day BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR d.advertiser_org_id = $3) AND ($4::uuid IS NULL OR d.campaign_id = $4)`,
    [from, to, scope.advertiserOrgId ?? null, scope.campaignId ?? null])).rows[0];
  const partners = (await db.query(
    `SELECT pc.network_id, n.name, sum(s.impressions)::bigint AS impressions, sum(s.clicks)::bigint AS clicks, sum(s.conversions)::bigint AS conversions,
            sum(s.charged_micros)::bigint AS spend, sum(s.cost_micros)::bigint AS cost
     FROM partner_daily_stats s JOIN partner_campaigns pc ON pc.id = s.partner_campaign_id JOIN partner_networks n ON n.id = pc.network_id JOIN campaigns c ON c.id = pc.campaign_id
     WHERE s.day BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR c.org_id = $3) AND ($4::uuid IS NULL OR c.id = $4)
     GROUP BY pc.network_id, n.name ORDER BY n.name`,
    [from, to, scope.advertiserOrgId ?? null, scope.campaignId ?? null])).rows;
  const row = (source: string, name: string, r: Record<string, string | null>) => {
    const impressions = Number(r.impressions ?? 0);
    const clicks = Number(r.clicks ?? 0);
    const spend = big(r.spend);
    return {
      source, name, impressions, clicks, conversions: r.conversions === undefined ? null : Number(r.conversions ?? 0), spendMicros: spend.toString(),
      ctr: impressions ? (clicks / impressions) * 100 : null, cpcMicros: clicks ? (spend / BigInt(clicks)).toString() : null,
      ...(audience === 'admin' && r.cost !== undefined ? { costMicros: big(r.cost).toString(), marginMicros: (spend - big(r.cost)).toString() } : {}),
    };
  };
  return [row('blissnova', 'BlissNova network', own), ...partners.map((p) => row(p.network_id, p.name, p))];
}
