import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { PartnerAdSpec, PartnerAdStatus, PartnerAdapter, PartnerBudget, PartnerCampaignSpec, PartnerDayStats, PartnerState } from './partners';

/**
 * DEVELOPMENT ONLY. Behaves like an outside native network so partner
 * distribution can be tried end to end without a signed partner account:
 * campaigns are created, ads are reviewed (approved after a short delay,
 * rejected when the headline makes an exaggerated claim), and clicks and
 * cost accrue over time, never past the budgets BlissNova pushes. State lives
 * in Redis under partnersim:*. It refuses to load in production (see config
 * and the partner registry).
 */
interface SimAd { externalId: string; creativeId: string; headline: string; submittedAt: number; status: PartnerAdStatus['status']; reason?: string }
interface SimCampaign {
  createdAt: number; lastTick: number; state: PartnerState; cpcMicros: string; totalMicros: string; dailyMicros: string | null;
  seed: string; ads: SimAd[]; days: Record<string, { impressions: number; clicks: number; conversions: number; costMicros: string }>;
}

const REJECT = /\b(miracle|guaranteed|cure[sd]?|free money|get rich|100% free)\b/i;
const KEY = (id: string) => `partnersim:${id}`;
const DAY = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class SimulatedPartnerAdapter implements PartnerAdapter {
  readonly id = 'simulated';
  readonly devOnly = true;
  constructor(private redis: Redis, private now: () => number = Date.now, private opts: { reviewMs?: number; impressionsPerMinute?: number } = {}) {}

  status() {
    return { configured: true, detail: 'Development only: no real network, no real money. Never available in production.' };
  }
  async testConnection() {
    return { ok: true, detail: 'Simulated partner is answering.' };
  }

  private async load(externalId: string): Promise<SimCampaign> {
    const raw = await this.redis.get(KEY(externalId));
    if (!raw) throw new Error(`Simulated partner has no campaign ${externalId}`);
    return JSON.parse(raw) as SimCampaign;
  }
  private async save(externalId: string, c: SimCampaign) {
    await this.redis.set(KEY(externalId), JSON.stringify(c), 'EX', 90 * 86_400);
  }

  async createCampaign(spec: PartnerCampaignSpec, budget: PartnerBudget) {
    const externalId = `sim_${randomBytes(8).toString('hex')}`;
    const t = this.now();
    await this.save(externalId, {
      createdAt: t, lastTick: t, state: 'active', cpcMicros: budget.cpcMicros.toString(), totalMicros: budget.totalMicros.toString(),
      dailyMicros: budget.dailyMicros?.toString() ?? null, seed: createHash('sha256').update(spec.reference).digest('hex').slice(0, 8), ads: [], days: {},
    });
    return { externalId };
  }

  async updateBudget(externalId: string, budget: PartnerBudget) {
    const c = await this.advance(externalId);
    c.cpcMicros = budget.cpcMicros.toString();
    c.totalMicros = budget.totalMicros.toString();
    c.dailyMicros = budget.dailyMicros?.toString() ?? null;
    await this.save(externalId, c);
  }

  async setState(externalId: string, state: PartnerState) {
    const c = await this.advance(externalId);
    c.state = state;
    await this.save(externalId, c);
  }

  async submitAds(externalId: string, ads: PartnerAdSpec[]) {
    const c = await this.advance(externalId);
    const out: Array<{ creativeId: string; externalId: string }> = [];
    for (const a of ads) {
      c.ads = c.ads.filter((x) => x.creativeId !== a.creativeId);
      const ad: SimAd = { externalId: `simad_${randomBytes(6).toString('hex')}`, creativeId: a.creativeId, headline: a.headline, submittedAt: this.now(), status: 'in_review' };
      c.ads.push(ad);
      out.push({ creativeId: a.creativeId, externalId: ad.externalId });
    }
    await this.save(externalId, c);
    return out;
  }

  async fetchStatus(externalId: string) {
    const c = await this.advance(externalId);
    await this.save(externalId, c);
    return { ads: c.ads.map((a) => ({ externalId: a.externalId, status: a.status, reason: a.reason })) };
  }

  async fetchStats(externalId: string, fromDay: string, toDay: string): Promise<PartnerDayStats[]> {
    const c = await this.advance(externalId);
    await this.save(externalId, c);
    return Object.entries(c.days).filter(([d]) => d >= fromDay && d <= toDay).sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, impressions: v.impressions, clicks: v.clicks, conversions: v.conversions, costMicros: BigInt(v.costMicros) }));
  }

  /** Review pending ads and accrue delivery for the time since the last call. */
  private async advance(externalId: string): Promise<SimCampaign> {
    const c = await this.load(externalId);
    const t = this.now();
    const reviewMs = this.opts.reviewMs ?? 60_000;
    for (const a of c.ads) {
      if (a.status !== 'in_review' || t - a.submittedAt < reviewMs) continue;
      if (REJECT.test(a.headline)) {
        a.status = 'rejected';
        a.reason = 'Simulated partner policy: the headline makes an exaggerated or unverifiable claim.';
      } else a.status = 'approved';
    }
    const minutes = Math.min((t - c.lastTick) / 60_000, 24 * 60);
    c.lastTick = t;
    if (c.state !== 'active' || minutes <= 0 || !c.ads.some((a) => a.status === 'approved')) return c;
    const day = DAY(t);
    const d = (c.days[day] ??= { impressions: 0, clicks: 0, conversions: 0, costMicros: '0' });
    const cpc = BigInt(c.cpcMicros);
    // A steady, slightly noisy delivery curve. Higher bids win a little more click-through.
    const noise = 0.8 + (parseInt(createHash('sha256').update(`${c.seed}:${t}`).digest('hex').slice(0, 4), 16) / 0xffff) * 0.4;
    const impressions = Math.round(minutes * (this.opts.impressionsPerMinute ?? 300) * noise);
    const ctrPct = Math.min(2, 0.5 + Number(cpc) / 1_000_000);
    let clicks = Math.floor((impressions * ctrPct) / 100 + (noise - 0.8) * 2);
    const spentTotal = Object.values(c.days).reduce((s, v) => s + BigInt(v.costMicros), 0n);
    const roomTotal = BigInt(c.totalMicros) - spentTotal;
    const roomDaily = c.dailyMicros === null ? roomTotal : BigInt(c.dailyMicros) - BigInt(d.costMicros);
    const room = roomTotal < roomDaily ? roomTotal : roomDaily;
    const maxClicks = room > 0n && cpc > 0n ? Number(room / cpc) : 0;
    clicks = Math.max(0, Math.min(clicks, maxClicks));
    d.impressions += clicks === 0 && maxClicks === 0 ? 0 : impressions;
    d.clicks += clicks;
    d.conversions += Math.floor(clicks / 25);
    d.costMicros = (BigInt(d.costMicros) + BigInt(clicks) * cpc).toString();
    return c;
  }
}
