import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { toMicros } from '@blissnova/shared';
import { balance, releaseCampaignReserve } from '@blissnova/billing';
import { audit } from '../../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { bodyOf, idParams, moneyString, paramsOf, queryOf } from '../../lib/http';
import { tx } from '../../lib/tx';
import { requireUser } from '../../plugins/auth';
import { notifyOrg } from '../../services/notifications';
import { invalidateServingCache } from '../../services/serving';
import { adminList, guard, meta, mgmt, reasonOptional, reasonRequired, sortSql, Where } from './common';

const shareBody = z.object({ revenueShareBps: z.number().int().min(0).max(10000).nullable(), reason: z.string().trim().min(3).max(1000) });
const premiumBody = z.object({
  tier: z.enum(['standard', 'premium']),
  /** Publishers only. null removes the earnings minimum. */
  earningsMode: z.enum(['floor', 'guarantee']).nullable().default(null),
  minCpm: moneyString.nullable().default(null),
  minCpc: moneyString.nullable().default(null),
  guaranteeMonthlyCap: moneyString.nullable().default(null),
  premiumAdvertisersOnly: z.boolean().default(false),
  reason: z.string().trim().min(3).max(1000),
});
const restrictionsBody = z.object({
  restrictions: z.object({
    allowedPricingModels: z.array(z.enum(['cpm', 'cpc', 'flat'])).optional(),
    maxCampaignBudgetMicros: z.string().regex(/^\d+$/).optional(),
    note: z.string().max(500).optional(),
  }),
  reason: z.string().trim().min(3).max(1000),
});
const disputePatch = z.object({ status: z.enum(['open', 'under_review', 'resolved', 'rejected']), resolution: z.string().trim().max(2000).optional() });

export async function adminOrgRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;

  app.get('/admin/orgs', { preHandler: guard('admin:orgs:read'), schema: { tags: ['admin: organizations'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const w = new Where();
    if (q.type) w.add('o.type = ?', q.type);
    if (q.status) w.add('o.status = ?', q.status);
    if (q.q) w.add('o.name ILIKE ?', `%${q.q}%`);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM organizations o ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(
      `SELECT o.id, o.name, o.type, o.status, o.status_reason, o.country, o.currency, o.revenue_share_bps, o.tier, o.earnings_mode, o.created_at,
         (SELECT count(*) FROM memberships m WHERE m.org_id = o.id)::int AS members,
         (SELECT count(*) FROM campaigns c WHERE c.org_id = o.id AND c.status IN ('active', 'scheduled'))::int AS live_campaigns,
         (SELECT count(*) FROM sites s WHERE s.org_id = o.id AND s.status = 'approved')::int AS approved_sites
       FROM organizations o ${w.sql} ${sortSql(q, { name: 'o.name', created: 'o.created_at', status: 'o.status' }, 'created')}`, w.params)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  app.get('/admin/orgs/:id', { preHandler: guard('admin:orgs:read'), schema: { tags: ['admin: organizations'], params: idParams } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const o = (await db.query('SELECT * FROM organizations WHERE id = $1', [id])).rows[0];
    if (!o) throw notFound();
    const [members, campaigns, sites, payments, payouts, auditRows, notes, guarantees] = await Promise.all([
      db.query(`SELECT u.id, u.name, u.email, u.status, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1`, [id]),
      db.query(`SELECT id, name, status, pricing_model, lifetime_budget_micros, spent_micros, start_at, end_at FROM campaigns WHERE org_id = $1 ORDER BY created_at DESC LIMIT 100`, [id]),
      db.query(`SELECT id, name, domain, status, verified_at FROM sites WHERE org_id = $1 ORDER BY created_at DESC`, [id]),
      db.query(`SELECT id, provider, amount_micros, status, created_at FROM payments WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
      db.query(`SELECT id, amount_micros, status, created_at FROM payouts WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
      db.query(`SELECT a.action, a.reason, a.created_at, u.name AS actor FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.org_id = $1 ORDER BY a.created_at DESC LIMIT 50`, [id]),
      db.query(`SELECT n.id, n.body, n.created_at, a.name AS author FROM admin_notes n JOIN users a ON a.id = n.author_id WHERE n.subject_type = 'organization' AND n.subject_id = $1 ORDER BY n.created_at DESC`, [id]),
      db.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, impressions::text, clicks::text, earned_micros::text, required_micros::text, topup_micros::text, capped FROM publisher_guarantees WHERE org_id = $1 ORDER BY day DESC LIMIT 60`, [id]),
    ]);
    const kinds = o.type === 'advertiser' ? ['advertiser_wallet'] as const : ['publisher_pending', 'publisher_available', 'publisher_payout_processing'] as const;
    const balances: Record<string, string> = {};
    for (const k of kinds) balances[k] = (await balance(db as never, { kind: k, orgId: id }, o.currency)).toString();
    return { data: { ...o, members: members.rows, campaigns: campaigns.rows, sites: sites.rows, payments: payments.rows, payouts: payouts.rows, audit: auditRows.rows, notes: notes.rows, guarantees: guarantees.rows, balances } };
  });

  const statusAction = (action: 'approve' | 'reject' | 'suspend' | 'reinstate', perm: 'admin:orgs:review' | 'admin:orgs:suspend', from: string[], to: string, needReason: boolean) =>
    app.post(`/admin/orgs/:id/${action}`, { config: mgmt, preHandler: guard(perm), schema: { tags: ['admin: organizations'], params: idParams, body: needReason ? reasonRequired : reasonOptional } }, async (req) => {
      const actor = requireUser(req);
      const { id } = paramsOf(req, idParams);
      const reason = (req.body as { reason?: string }).reason ?? null;
      const s = await ctx.settings.get();
      const org = await tx(ctx, async (c) => {
        const o = (await c.query('SELECT * FROM organizations WHERE id = $1 FOR UPDATE', [id])).rows[0];
        if (!o) throw notFound();
        if (!from.includes(o.status)) throw conflict(`Cannot ${action} an organization that is ${o.status}`);
        await c.query('UPDATE organizations SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1', [id, to, reason]);
        if (action === 'suspend' && o.type === 'advertiser') {
          // Suspension stops delivery immediately (the serving snapshot excludes non-approved organizations); budgets remain reserved pending review.
          const live = (await c.query(`SELECT id FROM campaigns WHERE org_id = $1 AND status IN ('active', 'scheduled')`, [id])).rows;
          for (const l of live) await c.query(`INSERT INTO campaign_history (campaign_id, actor_id, action, reason) VALUES ($1, $2, 'org_suspended', $3)`, [l.id, actor.id, reason]);
        }
        if (action === 'reject' && o.type === 'advertiser') {
          for (const camp of (await c.query(`SELECT id FROM campaigns WHERE org_id = $1 AND status = 'pending_approval'`, [id])).rows) {
            await c.query(`UPDATE campaigns SET status = 'rejected', status_reason = $2 WHERE id = $1`, [camp.id, 'Advertiser account was not approved']);
            await releaseCampaignReserve(c, camp.id, { type: 'user', userId: actor.id }, 'Advertiser account rejected', s.publishers.earningsHoldDays);
          }
        }
        await audit(c, req, { action: `organization.${action}`, resourceType: 'organization', resourceId: id, orgId: id, before: { status: o.status }, after: { status: to }, reason });
        return o;
      });
      invalidateServingCache(ctx);
      await notifyOrg(ctx, id, { type: 'org_reviewed', title: `Account ${to}`, body: reason ?? '', link: `/${org.type}`, template: 'org_reviewed', vars: { orgName: org.name, orgType: org.type, decision: to, reason: reason ? `Reason: ${reason}` : '' }, roles: ['owner'] }).catch(() => undefined);
      return { ok: true, status: to };
    });
  statusAction('approve', 'admin:orgs:review', ['pending', 'rejected'], 'approved', false);
  statusAction('reject', 'admin:orgs:review', ['pending'], 'rejected', true);
  statusAction('suspend', 'admin:orgs:suspend', ['approved', 'pending'], 'suspended', true);
  statusAction('reinstate', 'admin:orgs:suspend', ['suspended'], 'approved', true);

  app.patch('/admin/orgs/:id/revenue-share', { config: mgmt, preHandler: guard('admin:pricing:manage', { stepUp: true }), schema: { tags: ['admin: organizations'], params: idParams, body: shareBody } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, shareBody);
    // Outside 30-90% requires a super administrator.
    if (b.revenueShareBps !== null && (b.revenueShareBps < 3000 || b.revenueShareBps > 9000) && actor.platformRole !== 'super_admin') throw forbidden('Revenue shares outside 30%–90% require a super administrator');
    const o = (await db.query(`SELECT revenue_share_bps, type FROM organizations WHERE id = $1`, [id])).rows[0];
    if (!o) throw notFound();
    if (o.type !== 'publisher') throw badRequest('Revenue share applies to publishers');
    await db.query('UPDATE organizations SET revenue_share_bps = $2, updated_at = now() WHERE id = $1', [id, b.revenueShareBps]);
    await audit(db, req, { action: 'organization.revenue_share', resourceType: 'organization', resourceId: id, orgId: id, before: { bps: o.revenue_share_bps }, after: { bps: b.revenueShareBps }, reason: b.reason });
    invalidateServingCache(ctx);
    return { ok: true };
  });

  // Premium tier, plus a premium publisher's earnings minimum: a price floor
  // (only ads that pay enough serve) or a network-funded guarantee with a
  // monthly cap. Money-affecting, so it needs pricing rights and step-up.
  app.patch('/admin/orgs/:id/premium', { config: mgmt, preHandler: guard('admin:pricing:manage', { stepUp: true }), schema: { tags: ['admin: organizations'], params: idParams, body: premiumBody } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, premiumBody);
    const o = (await db.query('SELECT type, tier, earnings_mode, min_cpm_micros, min_cpc_micros, guarantee_monthly_cap_micros, premium_advertisers_only FROM organizations WHERE id = $1', [id])).rows[0];
    if (!o) throw notFound();
    const micros = (v: string | null) => (v === null ? null : toMicros(v));
    const next = {
      tier: b.tier,
      earningsMode: b.earningsMode,
      minCpmMicros: b.earningsMode ? micros(b.minCpm) : null,
      minCpcMicros: b.earningsMode ? micros(b.minCpc) : null,
      guaranteeCapMicros: b.earningsMode === 'guarantee' ? micros(b.guaranteeMonthlyCap) : null,
      premiumOnly: b.premiumAdvertisersOnly,
    };
    if (o.type === 'advertiser' && (next.earningsMode || next.premiumOnly)) throw badRequest('Earnings minimums and premium-only inventory apply to publishers');
    if ((next.earningsMode || next.premiumOnly) && next.tier !== 'premium') throw badRequest('Only premium publishers can have an earnings minimum or premium-only inventory');
    if (next.earningsMode && !next.minCpmMicros && !next.minCpcMicros) throw badRequest('Set a minimum per 1,000 impressions, per click, or both');
    if ((next.minCpmMicros !== null && next.minCpmMicros <= 0n) || (next.minCpcMicros !== null && next.minCpcMicros <= 0n)) throw badRequest('Minimums must be greater than zero');
    if (next.earningsMode === 'guarantee' && next.guaranteeCapMicros === null) throw badRequest('A guarantee needs a monthly cap on network-funded top-ups');
    await tx(ctx, async (c) => {
      await c.query(
        `UPDATE organizations SET tier = $2, earnings_mode = $3, min_cpm_micros = $4, min_cpc_micros = $5, guarantee_monthly_cap_micros = $6, premium_advertisers_only = $7, updated_at = now() WHERE id = $1`,
        [id, next.tier, next.earningsMode, next.minCpmMicros?.toString() ?? null, next.minCpcMicros?.toString() ?? null, next.guaranteeCapMicros?.toString() ?? null, next.premiumOnly]);
      await audit(c, req, {
        action: 'organization.premium', resourceType: 'organization', resourceId: id, orgId: id, reason: b.reason,
        before: { tier: o.tier, earningsMode: o.earnings_mode, minCpmMicros: o.min_cpm_micros, minCpcMicros: o.min_cpc_micros, guaranteeCapMicros: o.guarantee_monthly_cap_micros, premiumOnly: o.premium_advertisers_only },
        after: { ...next, minCpmMicros: next.minCpmMicros?.toString() ?? null, minCpcMicros: next.minCpcMicros?.toString() ?? null, guaranteeCapMicros: next.guaranteeCapMicros?.toString() ?? null },
      });
    });
    invalidateServingCache(ctx);
    return { ok: true };
  });

  app.patch('/admin/orgs/:id/restrictions', { config: mgmt, preHandler: guard('admin:orgs:suspend'), schema: { tags: ['admin: organizations'], params: idParams, body: restrictionsBody } }, async (req) => {
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, restrictionsBody);
    const o = (await db.query('SELECT restrictions FROM organizations WHERE id = $1', [id])).rows[0];
    if (!o) throw notFound();
    await db.query('UPDATE organizations SET restrictions = $2, updated_at = now() WHERE id = $1', [id, JSON.stringify(b.restrictions)]);
    await audit(db, req, { action: 'organization.restrictions', resourceType: 'organization', resourceId: id, orgId: id, before: o.restrictions, after: b.restrictions, reason: b.reason });
    return { ok: true };
  });

  app.get('/admin/disputes', { preHandler: guard('admin:finance:read'), schema: { tags: ['admin: organizations'], querystring: adminList } }, async (req) => {
    const q = queryOf(req, adminList);
    const w = new Where();
    if (q.status) w.add('d.status = ?', q.status);
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM disputes d ${w.sql}`, w.params)).rows[0].n);
    const rows = (await db.query(`SELECT d.*, o.name AS org_name, o.type AS org_type FROM disputes d JOIN organizations o ON o.id = d.org_id ${w.sql} ${sortSql(q, { created: 'd.created_at' }, 'created')}`, w.params)).rows;
    return { data: rows, meta: meta(q, total) };
  });

  app.patch('/admin/disputes/:id', { config: mgmt, preHandler: guard('admin:finance:manage'), schema: { tags: ['admin: organizations'], params: idParams, body: disputePatch } }, async (req) => {
    const actor = requireUser(req);
    const { id } = paramsOf(req, idParams);
    const b = bodyOf(req, disputePatch);
    if (['resolved', 'rejected'].includes(b.status) && !b.resolution) throw badRequest('Record the resolution');
    const r = await db.query(`UPDATE disputes SET status = $2, resolution = COALESCE($3, resolution), resolved_by = CASE WHEN $2 IN ('resolved', 'rejected') THEN $4::uuid ELSE resolved_by END, updated_at = now() WHERE id = $1 RETURNING org_id`, [id, b.status, b.resolution ?? null, actor.id]);
    if (!r.rowCount) throw notFound();
    await audit(db, req, { action: 'dispute.update', resourceType: 'dispute', resourceId: id, orgId: r.rows[0].org_id, after: b });
    return { ok: true };
  });
}
