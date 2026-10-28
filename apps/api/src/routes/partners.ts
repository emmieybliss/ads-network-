import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { toMicros } from '@blissnova/shared';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { bodyOf, dateRange, moneyString, orgIdParams, orgParams, paramsOf, queryOf, resolveRange } from '../lib/http';
import { tx } from '../lib/tx';
import { requireOrg, requireUser } from '../plugins/auth';
import { loadPartnerCampaigns, sourceReport, syncPartnerCampaigns } from '../services/partners';
import { adminList, guard, meta, mgmt, reasonRequired, sortSql, Where } from './admin/common';

const distributionBody = z.object({
  networks: z.array(z.object({ networkId: z.string().max(32), budgetPercent: z.number().int().min(1).max(100) })).max(10),
});
const networkPatch = z.object({
  enabled: z.boolean().optional(),
  markupPercent: z.number().min(0).max(200).optional(),
  minCpc: moneyString.optional(),
  reason: z.string().trim().min(3).max(1000),
});
const networkParams = z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/) });
const sourceQuery = dateRange.extend({ campaignId: z.uuid().optional() });

export async function partnerRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const adv = { type: 'advertiser' as const };

  /** Networks an advertiser can choose: switched on by staff and connected. */
  async function offeredNetworks() {
    const rows = (await db.query(`SELECT * FROM partner_networks WHERE enabled ORDER BY dev_only, name`)).rows;
    return rows.filter((r) => ctx.partners.describe(r.id).available);
  }

  function eligibility(c: Record<string, any>, nativeApproved: number, nativeAny: number) {
    const reasons: string[] = [];
    if (c.pricing_model !== 'cpc') reasons.push('Partner networks sell clicks, so only cost-per-click campaigns can run there.');
    if (['completed', 'archived', 'suspended'].includes(c.status)) reasons.push(`A ${c.status} campaign cannot start on partner networks.`);
    if (nativeAny === 0) reasons.push('Partner networks show native ads only: add a native ad with an image, a headline and the sponsor name.');
    return { ok: reasons.length === 0, reasons, nativeAdsApproved: nativeApproved };
  }

  // ---------------------------------------------------------------- advertiser
  app.get('/orgs/:orgId/partner-networks', { preHandler: requireOrg('campaign:read', { ...adv, allowSuspended: true }), schema: { tags: ['partner networks'], params: orgParams, description: 'Outside networks this account can extend CPC campaigns to.' } }, async () => {
    return {
      data: (await offeredNetworks()).map((r) => ({
        id: r.id, name: r.name, website: r.website, simulated: r.dev_only, serviceFeePercent: r.markup_bps / 100,
        // The lowest CPC that still leaves the partner its minimum bid after BlissNova's fee.
        minCpcMicros: ((BigInt(r.min_cpc_micros) * BigInt(10_000 + r.markup_bps)) / 10_000n).toString(),
      })),
    };
  });

  app.get('/orgs/:orgId/campaigns/:id/partners', { preHandler: requireOrg('campaign:read', { ...adv, allowSuspended: true }), schema: { tags: ['partner networks'], params: orgIdParams } }, async (req) => {
    const { id } = paramsOf(req, orgIdParams);
    const c = (await db.query('SELECT * FROM campaigns WHERE id = $1 AND org_id = $2', [id, req.org!.id])).rows[0];
    if (!c) throw notFound();
    const n = (await db.query(`SELECT count(*) FILTER (WHERE approved_version IS NOT NULL)::int AS approved, count(*)::int AS total FROM creatives WHERE campaign_id = $1 AND format = 'native' AND status <> 'archived'`, [id])).rows[0];
    return { data: { eligibility: eligibility(c, n.approved, n.total), partners: await loadPartnerCampaigns(db, id, 'advertiser') } };
  });

  app.put('/orgs/:orgId/campaigns/:id/partners', { config: { rateLimit: { bucket: 'management' as const } }, preHandler: requireOrg('campaign:write', adv), schema: { tags: ['partner networks'], params: orgIdParams, body: distributionBody, description: 'Choose the partner networks a CPC campaign also runs on, and the most of its budget each may spend.' } }, async (req) => {
    const user = requireUser(req);
    const { id } = paramsOf(req, orgIdParams);
    const b = bodyOf(req, distributionBody);
    if (new Set(b.networks.map((x) => x.networkId)).size !== b.networks.length) throw badRequest('Each partner network can be listed once');
    if (b.networks.reduce((s, x) => s + x.budgetPercent, 0) > 100) throw badRequest('Partner budget shares cannot add up to more than 100% of the campaign budget');
    const offered = new Map((await offeredNetworks()).map((r) => [r.id, r]));
    await tx(ctx, async (cl) => {
      const c = (await cl.query('SELECT * FROM campaigns WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, req.org!.id])).rows[0];
      if (!c) throw notFound();
      const existing = (await cl.query('SELECT * FROM partner_campaigns WHERE campaign_id = $1', [id])).rows;
      const before = existing.map((r) => ({ networkId: r.network_id, budgetPercent: r.budget_share_bps / 100, status: r.status }));
      if (b.networks.length) {
        const n = (await cl.query(`SELECT count(*) FILTER (WHERE approved_version IS NOT NULL)::int AS approved, count(*)::int AS total FROM creatives WHERE campaign_id = $1 AND format = 'native' AND status <> 'archived'`, [id])).rows[0];
        const e = eligibility(c, n.approved, n.total);
        if (!e.ok) throw conflict(e.reasons[0]!);
      }
      for (const x of b.networks) {
        const net = offered.get(x.networkId);
        const had = existing.find((r) => r.network_id === x.networkId);
        if (!net && !had) throw badRequest(`${x.networkId} is not available`);
        if (net) {
          const partnerCpc = (BigInt(c.rate_micros) * 10_000n) / BigInt(10_000 + net.markup_bps);
          if (partnerCpc < BigInt(net.min_cpc_micros)) throw badRequest(`${net.name} needs a CPC of at least ${(Number(BigInt(net.min_cpc_micros) * BigInt(10_000 + net.markup_bps) / 10_000n) / 1e6).toFixed(2)}`);
        }
        if (had) {
          // Choosing a removed partner again resumes the same partner-side campaign, so its delivery history stays continuous.
          await cl.query(
            `UPDATE partner_campaigns SET budget_share_bps = $2, removed_at = NULL, status = CASE WHEN status = 'stopped' THEN 'paused' ELSE status END, updated_at = now() WHERE id = $1`,
            [had.id, x.budgetPercent * 100]);
        } else {
          await cl.query(`INSERT INTO partner_campaigns (campaign_id, network_id, budget_share_bps, markup_bps, status_reason) VALUES ($1, $2, $3, $4, 'Starts on the partner network once the campaign is live.')`,
            [id, x.networkId, x.budgetPercent * 100, net!.markup_bps]);
        }
      }
      for (const r of existing.filter((r) => !b.networks.some((x) => x.networkId === r.network_id))) {
        // Never sent to the partner: nothing to keep. Otherwise keep what ran, for reports and the ledger; the next sync stops it there.
        if (!r.external_id) await cl.query('DELETE FROM partner_campaigns WHERE id = $1', [r.id]);
        else await cl.query(`UPDATE partner_campaigns SET removed_at = COALESCE(removed_at, now()), updated_at = now() WHERE id = $1`, [r.id]);
      }
      const after = b.networks;
      await cl.query(`INSERT INTO campaign_history (campaign_id, actor_id, action, before, after) VALUES ($1, $2, 'partners_updated', $3, $4)`, [id, user.id, JSON.stringify(before), JSON.stringify(after)]);
      await audit(cl, req, { action: 'campaign.partners_update', resourceType: 'campaign', resourceId: id, orgId: req.org!.id, before, after });
    });
    // Reflect the change on the partner right away rather than at the next scheduled pass.
    await syncPartnerCampaigns({ db, partners: ctx.partners, publicUrl: (k) => ctx.storage.publicUrl(k), log: ctx.log }, { campaignId: id }).catch(() => undefined);
    return { data: await loadPartnerCampaigns(db, id, 'advertiser') };
  });

  app.get('/orgs/:orgId/reports/sources', { preHandler: requireOrg('report:read', { ...adv, allowSuspended: true }), schema: { tags: ['reports'], params: orgParams, querystring: sourceQuery, description: 'Delivery and spend by source: the BlissNova network and each partner network.' } }, async (req) => {
    const q = queryOf(req, sourceQuery);
    const range = resolveRange(q);
    return { data: { range, rows: await sourceReport(db, { advertiserOrgId: req.org!.id, campaignId: q.campaignId }, range.from, range.to, 'advertiser') } };
  });

  // ---------------------------------------------------------------- admin
  async function describeNetwork(r: Record<string, any>) {
    const d = ctx.partners.describe(r.id);
    const totals = (await db.query(
      `SELECT count(*) FILTER (WHERE pc.status IN ('active', 'in_review'))::int AS live, count(*)::int AS campaigns,
              COALESCE(sum(s.cost), 0)::text AS cost, COALESCE(sum(s.charged), 0)::text AS charged, COALESCE(sum(s.clicks), 0)::text AS clicks, COALESCE(sum(pc.absorbed_micros), 0)::text AS absorbed
       FROM partner_campaigns pc LEFT JOIN (SELECT partner_campaign_id, sum(cost_micros) AS cost, sum(charged_micros) AS charged, sum(clicks) AS clicks FROM partner_daily_stats WHERE day > CURRENT_DATE - 30 GROUP BY partner_campaign_id) s ON s.partner_campaign_id = pc.id
       WHERE pc.network_id = $1`, [r.id])).rows[0];
    return {
      id: r.id, name: r.name, website: r.website, devOnly: r.dev_only, enabled: r.enabled, available: d.available, connection: d.detail,
      markupPercent: r.markup_bps / 100, minCpcMicros: r.min_cpc_micros, notes: r.notes,
      lastCheck: r.last_checked_at ? { ok: r.last_check_ok, detail: r.last_check_detail, at: r.last_checked_at } : null,
      liveCampaigns: totals.live, campaigns: totals.campaigns,
      last30Days: { clicks: Number(totals.clicks), costMicros: totals.cost, chargedMicros: totals.charged, marginMicros: (BigInt(totals.charged) - BigInt(totals.cost)).toString(), absorbedMicros: totals.absorbed },
      updatedAt: r.updated_at,
    };
  }

  app.get('/admin/partners', { preHandler: guard('admin:campaigns:read'), schema: { tags: ['admin: partner networks'] } }, async () => {
    const rows = (await db.query('SELECT * FROM partner_networks ORDER BY dev_only, name')).rows;
    // The simulator is listed only where it can run, so production never shows it.
    const visible = rows.filter((r) => !r.dev_only || ctx.partners.describe(r.id).available);
    return { data: await Promise.all(visible.map(describeNetwork)) };
  });

  app.patch('/admin/partners/:id', { config: mgmt, preHandler: guard('admin:pricing:manage'), schema: { tags: ['admin: partner networks'], params: networkParams, body: networkPatch } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, networkParams);
    const b = bodyOf(req, networkPatch);
    const row = await tx(ctx, async (cl) => {
      const before = (await cl.query('SELECT * FROM partner_networks WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw notFound();
      if (b.enabled && !ctx.partners.describe(id).available) throw conflict(`${before.name} is not connected. ${ctx.partners.describe(id).detail}`);
      const after = (await cl.query(
        `UPDATE partner_networks SET enabled = COALESCE($2, enabled), markup_bps = COALESCE($3, markup_bps), min_cpc_micros = COALESCE($4, min_cpc_micros), updated_by = $5, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, b.enabled ?? null, b.markupPercent === undefined ? null : Math.round(b.markupPercent * 100), b.minCpc ? toMicros(b.minCpc).toString() : null, actor.id])).rows[0];
      const pick = (r: any) => ({ enabled: r.enabled, markupBps: r.markup_bps, minCpcMicros: r.min_cpc_micros });
      await audit(cl, req, { action: 'partner_network.update', resourceType: 'partner_network', resourceId: id, before: pick(before), after: pick(after), reason: b.reason });
      return after;
    });
    return { data: await describeNetwork(row) };
  });

  app.post('/admin/partners/:id/test', { config: mgmt, preHandler: guard('admin:pricing:manage'), schema: { tags: ['admin: partner networks'], params: networkParams } }, async (req) => {
    const { id } = paramsOf(req, networkParams);
    const row = (await db.query('SELECT * FROM partner_networks WHERE id = $1', [id])).rows[0];
    if (!row) throw notFound();
    const adapter = ctx.partners.get(id);
    const result = adapter ? await adapter.testConnection().catch((e: Error) => ({ ok: false, detail: e.message })) : { ok: false, detail: ctx.partners.describe(id).detail };
    const upd = (await db.query('UPDATE partner_networks SET last_check_ok = $2, last_check_detail = $3, last_checked_at = now() WHERE id = $1 RETURNING *', [id, result.ok, result.detail.slice(0, 500)])).rows[0];
    return { data: await describeNetwork(upd) };
  });

  const pcList = adminList.extend({ networkId: z.string().max(32).optional() });
  app.get('/admin/partner-campaigns', { preHandler: guard('admin:campaigns:read'), schema: { tags: ['admin: partner networks'], querystring: pcList } }, async (req) => {
    const q = queryOf(req, pcList);
    const w = new Where();
    if (q.status) w.add('pc.status = ?', q.status);
    if (q.networkId) w.add('pc.network_id = ?', q.networkId);
    if (q.q) w.add('(c.name ILIKE ? OR o.name ILIKE ?)', `%${q.q}%`);
    const from = `FROM partner_campaigns pc JOIN campaigns c ON c.id = pc.campaign_id JOIN organizations o ON o.id = c.org_id JOIN partner_networks n ON n.id = pc.network_id`;
    const total = Number((await db.query(`SELECT count(*)::int AS n ${from} ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(`SELECT pc.*, c.name AS campaign_name, c.status AS campaign_status, o.name AS org_name, n.name AS network_name ${from} ${w.sql} ${sortSql(q, { created: 'pc.created_at', spend: 'pc.charged_micros', synced: 'pc.last_synced_at' }, 'created')}`, w.params)).rows;
    return {
      data: rows.map((r) => ({
        id: r.id, campaignId: r.campaign_id, campaignName: r.campaign_name, campaignStatus: r.campaign_status, orgName: r.org_name, networkId: r.network_id, networkName: r.network_name,
        status: r.status, statusReason: r.status_reason, budgetPercent: r.budget_share_bps / 100, markupPercent: r.markup_bps / 100, externalId: r.external_id,
        impressions: Number(r.impressions), clicks: Number(r.clicks), costMicros: r.cost_micros, chargedMicros: r.charged_micros, absorbedMicros: r.absorbed_micros,
        adminHold: r.admin_hold, adminHoldReason: r.admin_hold_reason, lastSyncedAt: r.last_synced_at,
      })),
      meta: meta(q, total),
    };
  });

  for (const action of ['hold', 'release'] as const) {
    app.post(`/admin/partner-campaigns/:id/${action}`, { config: mgmt, preHandler: guard('admin:campaigns:override'), schema: { tags: ['admin: partner networks'], params: z.object({ id: z.uuid() }), body: reasonRequired } }, async (req) => {
      const { id } = paramsOf(req, z.object({ id: z.uuid() }));
      const user = requireUser(req);
      const { reason } = bodyOf(req, reasonRequired);
      const row = await tx(ctx, async (cl) => {
        const r = (await cl.query(`UPDATE partner_campaigns SET admin_hold = $2, admin_hold_reason = $3, updated_at = now() WHERE id = $1 RETURNING *`, [id, action === 'hold', action === 'hold' ? reason : null])).rows[0];
        if (!r) throw notFound();
        const org = (await cl.query('SELECT org_id FROM campaigns WHERE id = $1', [r.campaign_id])).rows[0];
        await cl.query(`INSERT INTO campaign_history (campaign_id, actor_id, action, after, reason) VALUES ($1, $2, $3, $4, $5)`, [r.campaign_id, user.id, `partner_${action}`, JSON.stringify({ networkId: r.network_id }), reason]);
        await audit(cl, req, { action: `partner_campaign.${action}`, resourceType: 'partner_campaign', resourceId: id, orgId: org.org_id, after: { adminHold: action === 'hold' }, reason });
        return r;
      });
      await syncPartnerCampaigns({ db, partners: ctx.partners, publicUrl: (k) => ctx.storage.publicUrl(k), log: ctx.log }, { campaignId: row.campaign_id }).catch(() => undefined);
      return { data: (await loadPartnerCampaigns(db, row.campaign_id, 'admin')).find((p) => p.id === id) };
    });
  }

  app.get('/admin/campaigns/:id/partners', { preHandler: guard('admin:campaigns:read'), schema: { tags: ['admin: partner networks'], params: z.object({ id: z.uuid() }) } }, async (req) => {
    const { id } = paramsOf(req, z.object({ id: z.uuid() }));
    return { data: await loadPartnerCampaigns(db, id, 'admin') };
  });

  app.get('/admin/reports/sources', { preHandler: guard('admin:campaigns:read'), schema: { tags: ['admin: partner networks'], querystring: sourceQuery } }, async (req) => {
    const q = queryOf(req, sourceQuery);
    const range = resolveRange(q);
    return { data: { range, rows: await sourceReport(db, { campaignId: q.campaignId }, range.from, range.to, 'admin') } };
  });
}
