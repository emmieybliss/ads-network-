import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { releaseCampaignReserve, releaseExcessReserve, reserveCampaignBudget } from '@blissnova/billing';
import { ADMIN_CAMPAIGN_TRANSITIONS, toMicros, type CampaignStatus } from '@blissnova/shared';
import { audit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { bodyOf, idParams, moneyString, paramsOf, queryOf } from '../../lib/http';
import { tx } from '../../lib/tx';
import { requireUser } from '../../plugins/auth';
import { liveStatus, loadCampaign, recordHistory, serializeCampaign } from '../../services/campaigns';
import { serializeCreative } from '../../services/creatives';
import { notifyOrg } from '../../services/notifications';
import { invalidateServingCache } from '../../services/serving';
import { runReport } from '../../services/reports';
import { adminList, guard, meta, mgmt, reasonOptional, reasonRequired, sortSql, Where } from './common';

const limitsBody = z.object({
  lifetimeBudget: moneyString.optional(),
  dailyBudget: moneyString.nullable().optional(),
  maxImpressions: z.number().int().positive().nullable().optional(),
  priorityBoost: z.number().int().min(-5).max(5).optional(),
  reason: z.string().trim().min(3).max(1000),
});

export async function adminCampaignRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;

  app.get('/admin/campaigns', { preHandler: guard('admin:campaigns:read'), schema: { tags: ['admin: campaigns'], querystring: adminList.extend({ orgId: z.uuid().optional() }) } }, async (req) => {
    const q = queryOf(req, adminList.extend({ orgId: z.uuid().optional() }));
    const w = new Where();
    if (q.status) w.add('c.status = ?', q.status);
    if (q.orgId) w.add('c.org_id = ?', q.orgId);
    if (q.q) w.add('(c.name ILIKE ? OR o.name ILIKE ?)', `%${q.q}%`);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM campaigns c JOIN organizations o ON o.id = c.org_id ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(`SELECT c.*, o.name AS org_name, o.status AS org_status FROM campaigns c JOIN organizations o ON o.id = c.org_id ${w.sql} ${sortSql(q, { name: 'c.name', created: 'c.created_at', submitted: 'c.submitted_at', spend: 'c.spent_micros', status: 'c.status' }, 'created')}`, w.params)).rows;
    return { data: rows.map((r) => ({ ...serializeCampaign(r), orgName: r.org_name, orgStatus: r.org_status })), meta: meta(q, total) };
  });

  app.get('/admin/campaigns/:id', { preHandler: guard('admin:campaigns:read'), schema: { tags: ['admin: campaigns'], params: idParams } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const c = await loadCampaign(db, id);
    if (!c) throw notFound();
    const org = (await db.query('SELECT id, name, status FROM organizations WHERE id = $1', [c.orgId])).rows[0];
    const creatives = (await db.query('SELECT c.*, a.storage_key FROM creatives c LEFT JOIN assets a ON a.id = c.asset_id WHERE c.campaign_id = $1 ORDER BY c.created_at', [id])).rows;
    const history = (await db.query(`SELECT h.action, h.before, h.after, h.reason, h.created_at, u.name AS actor FROM campaign_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.campaign_id = $1 ORDER BY h.created_at DESC LIMIT 100`, [id])).rows;
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const stats = await runReport(db, {}, { from, to, campaignId: id }, 'site', 'admin', 50);
    return { data: { ...c, org, creatives: creatives.map((r) => serializeCreative(r, r.storage_key ? ctx.storage.publicUrl(r.storage_key) : null)), history, last30DaysBySite: stats } };
  });

  const action = (name: keyof typeof ADMIN_CAMPAIGN_TRANSITIONS, needReason: boolean, perm: 'admin:campaigns:review' | 'admin:campaigns:override') =>
    app.post(`/admin/campaigns/:id/${name}`, { config: mgmt, preHandler: guard(perm), schema: { tags: ['admin: campaigns'], params: idParams, body: needReason ? reasonRequired : reasonOptional } }, async (req) => {
      const actor = requireUser(req);
      const { id } = paramsOf(req, idParams);
      const reason = (req.body as { reason?: string }).reason ?? null;
      const s = await ctx.settings.get();
      const result = await tx(ctx, async (c) => {
        const row = (await c.query('SELECT c.*, o.status AS org_status FROM campaigns c JOIN organizations o ON o.id = c.org_id WHERE c.id = $1 FOR UPDATE OF c', [id])).rows[0];
        if (!row) throw notFound();
        if (!ADMIN_CAMPAIGN_TRANSITIONS[name]!.includes(row.status)) throw conflict(`Cannot ${name} a campaign that is ${row.status.replace('_', ' ')}`);
        let next: CampaignStatus;
        switch (name) {
          case 'approve': {
            if (row.org_status !== 'approved') throw conflict('Approve the advertiser account before approving its campaigns');
            const approved = Number((await c.query(`SELECT count(*)::int AS n FROM creatives WHERE campaign_id = $1 AND approved_version IS NOT NULL AND status <> 'archived'`, [id])).rows[0].n);
            if (approved === 0) throw conflict('Approve at least one creative first');
            if (BigInt(row.reserved_micros) < BigInt(row.lifetime_budget_micros)) await reserveCampaignBudget(c, id, { type: 'user', userId: actor.id });
            next = liveStatus(row.start_at);
            await c.query(`UPDATE campaigns SET status = $2, approved_at = now(), approved_by = $3, status_reason = NULL, updated_at = now() WHERE id = $1`, [id, next, actor.id]);
            break;
          }
          case 'reject':
            next = 'rejected';
            await c.query(`UPDATE campaigns SET status = 'rejected', status_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
            await releaseCampaignReserve(c, id, { type: 'user', userId: actor.id }, `Campaign rejected: ${reason}`, s.publishers.earningsHoldDays);
            break;
          case 'pause':
            next = 'paused';
            await c.query(`UPDATE campaigns SET status = 'paused', status_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
            break;
          case 'resume':
            next = liveStatus(row.start_at);
            await c.query(`UPDATE campaigns SET status = $2, status_reason = NULL, updated_at = now() WHERE id = $1`, [id, next]);
            break;
          case 'suspend':
            next = 'suspended';
            await c.query(`UPDATE campaigns SET status = 'suspended', status_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
            break;
          default:
            next = 'completed';
            await c.query(`UPDATE campaigns SET status = 'completed', status_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
            await releaseCampaignReserve(c, id, { type: 'user', userId: actor.id }, `Campaign terminated: ${reason}`, s.publishers.earningsHoldDays);
        }
        await recordHistory(c, id, actor.id, `admin_${name}`, { status: row.status }, { status: next }, reason);
        await audit(c, req, { action: `campaign.admin_${name}`, resourceType: 'campaign', resourceId: id, orgId: row.org_id, before: { status: row.status }, after: { status: next }, reason });
        return { row, next };
      });
      invalidateServingCache(ctx);
      if (name === 'approve' || name === 'reject') {
        await notifyOrg(ctx, result.row.org_id, { type: `campaign_${name === 'approve' ? 'approved' : 'rejected'}`, title: `Campaign ${name === 'approve' ? 'approved' : 'needs changes'}: ${result.row.name}`, body: reason ?? '', link: `/advertiser/campaigns/${id}`, template: name === 'approve' ? 'campaign_approved' : 'campaign_rejected', vars: { campaignName: result.row.name, reason: reason ?? '' } }).catch(() => undefined);
      }
      return { data: await loadCampaign(db, id) };
    });
  action('approve', false, 'admin:campaigns:review');
  action('reject', true, 'admin:campaigns:review');
  action('pause', true, 'admin:campaigns:override');
  action('resume', true, 'admin:campaigns:override');
  action('suspend', true, 'admin:campaigns:override');
  action('terminate', true, 'admin:campaigns:override');

  app.patch('/admin/campaigns/:id/limits', { config: mgmt, preHandler: guard('admin:campaigns:override', { stepUp: true }), schema: { tags: ['admin: campaigns'], params: idParams, body: limitsBody } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, limitsBody);
    await tx(ctx, async (c) => {
      const before = await loadCampaign(c, id);
      if (!before) throw notFound();
      await c.query('SELECT 1 FROM campaigns WHERE id = $1 FOR UPDATE', [id]);
      const lifetime = b.lifetimeBudget ? toMicros(b.lifetimeBudget) : BigInt(before.lifetimeBudgetMicros);
      const daily = b.dailyBudget === undefined ? (before.dailyBudgetMicros ? BigInt(before.dailyBudgetMicros) : null) : b.dailyBudget === null ? null : toMicros(b.dailyBudget);
      if (lifetime < BigInt(before.spentMicros)) throw badRequest('Lifetime budget cannot be below the amount spent');
      if (daily !== null && daily > lifetime) throw badRequest('Daily budget cannot exceed lifetime budget');
      await c.query(`UPDATE campaigns SET lifetime_budget_micros = $2, daily_budget_micros = $3, max_impressions = CASE WHEN $4::boolean THEN $5 ELSE max_impressions END, admin_priority_boost = COALESCE($6, admin_priority_boost), updated_at = now() WHERE id = $1`,
        [id, lifetime.toString(), daily?.toString() ?? null, b.maxImpressions !== undefined, b.maxImpressions ?? null, b.priorityBoost ?? null]);
      if (BigInt(before.reservedMicros) > 0n) {
        if (lifetime > BigInt(before.reservedMicros)) await reserveCampaignBudget(c, id, { type: 'user', userId: actor.id });
        else await releaseExcessReserve(c, id, { type: 'user', userId: actor.id });
      }
      const after = await loadCampaign(c, id);
      await recordHistory(c, id, actor.id, 'admin_limits', before, after, b.reason);
      await audit(c, req, { action: 'campaign.admin_limits', resourceType: 'campaign', resourceId: id, orgId: before.orgId, before, after, reason: b.reason });
    });
    invalidateServingCache(ctx);
    return { data: await loadCampaign(db, id) };
  });

  // ---------------------------------------------------------------- creative review
  app.get('/admin/creatives', { preHandler: guard('admin:campaigns:read'), schema: { tags: ['admin: campaigns'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const w = new Where();
    w.add('cr.status = ?', q.status ?? 'pending_review');
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM creatives cr ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(
      `SELECT cr.*, a.storage_key, c.name AS campaign_name, c.status AS campaign_status, o.name AS org_name FROM creatives cr JOIN campaigns c ON c.id = cr.campaign_id JOIN organizations o ON o.id = cr.org_id LEFT JOIN assets a ON a.id = cr.asset_id
       ${w.sql} ${sortSql(q, { created: 'cr.updated_at' }, 'created')}`, w.params)).rows;
    return { data: rows.map((r) => ({ ...serializeCreative(r, r.storage_key ? ctx.storage.publicUrl(r.storage_key) : null), campaignName: r.campaign_name, campaignStatus: r.campaign_status, orgName: r.org_name })), meta: meta(q, total) };
  });

  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/admin/creatives/:id/${decision}`, { config: mgmt, preHandler: guard('admin:creatives:review'), schema: { tags: ['admin: campaigns'], params: idParams, body: decision === 'reject' ? reasonRequired : reasonOptional } }, async (req) => {
      const actor = requireUser(req);
      const { id } = paramsOf(req, idParams);
      const reason = (req.body as { reason?: string }).reason ?? null;
      const cr = await tx(ctx, async (c) => {
        const row = (await c.query('SELECT * FROM creatives WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!row) throw notFound();
        if (row.status !== 'pending_review') throw conflict('This creative is not awaiting review');
        const snap = await c.query('SELECT 1 FROM creative_versions WHERE creative_id = $1 AND version = $2', [id, row.version]);
        if (!snap.rowCount) throw conflict('No submitted snapshot exists for this version');
        if (decision === 'approve') await c.query(`UPDATE creatives SET status = 'approved', approved_version = version, rejection_reason = NULL, updated_at = now() WHERE id = $1`, [id]);
        else await c.query(`UPDATE creatives SET status = 'rejected', rejection_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
        await c.query('INSERT INTO creative_reviews (creative_id, version, decision, reason, reviewer_id) VALUES ($1, $2, $3, $4, $5)', [id, row.version, decision === 'approve' ? 'approved' : 'rejected', reason, actor.id]);
        await audit(c, req, { action: `creative.${decision}`, resourceType: 'creative', resourceId: id, orgId: row.org_id, after: { version: row.version }, reason });
        return row;
      });
      invalidateServingCache(ctx);
      await notifyOrg(ctx, cr.org_id, { type: `creative_${decision}d`, title: `Creative ${decision === 'approve' ? 'approved' : 'rejected'}: ${cr.name}`, body: reason ?? '', link: `/advertiser/campaigns/${cr.campaign_id}`, template: decision === 'approve' ? 'creative_approved' : 'creative_rejected', vars: { creativeName: cr.name, reason: reason ?? '' }, roles: ['owner', 'manager'] }).catch(() => undefined);
      return { ok: true };
    });
  }
}
