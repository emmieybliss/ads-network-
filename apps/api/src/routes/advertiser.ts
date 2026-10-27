import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ADVERTISER_CAMPAIGN_TRANSITIONS, formatMicros, type CampaignStatus } from '@blissnova/shared';
import { releaseCampaignReserve, releaseExcessReserve, reserveCampaignBudget } from '@blissnova/billing';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { bodyOf, orgIdParams, orgParams, paramsOf, queryOf } from '../lib/http';
import { offset, orderBy, pageMeta, pageQuery } from '../lib/pagination';
import { tx } from '../lib/tx';
import { requireOrg, requireUser } from '../plugins/auth';
import { campaignBody, campaignPatch, liveStatus, loadCampaign, recordHistory, serializeCampaign, validateCampaignRules, writeTargetingAndCaps, type CampaignInput } from '../services/campaigns';
import { creativeSnapshot, inspectImage, serializeCreative, validateDestinationUrl } from '../services/creatives';
import { notifyStaff } from '../services/notifications';
import { invalidateServingCache } from '../services/serving';

const listQuery = pageQuery.extend({ status: z.string().max(40).optional() });
const creativeBody = z.object({
  name: z.string().trim().min(1).max(160),
  format: z.enum(['image', 'text', 'native']),
  headline: z.string().trim().min(1).max(90).optional(),
  body: z.string().trim().max(200).optional(),
  cta: z.string().trim().max(30).optional(),
  assetId: z.uuid().optional(),
  altText: z.string().trim().max(200).optional(),
  destinationUrl: z.string().max(2048),
  displayUrl: z.string().trim().max(100).optional(),
  /** Native ads only: the brand shown as "Sponsored by …". */
  sponsorName: z.string().trim().min(1).max(60).optional(),
});
const creativePatch = creativeBody.partial().omit({ format: true });

export async function advertiserRoutes(app: FastifyInstance) {
  const { db } = app.ctx;
  const mgmt = { rateLimit: { bucket: 'management' as const } };
  const adv = { type: 'advertiser' as const };

  async function blockedDomains() {
    return (await db.query<{ value: string }>(`SELECT value FROM inventory_rules WHERE kind = 'blocked_destination_domain'`)).rows.map((r) => r.value);
  }

  // ---------------------------------------------------------------- campaigns
  app.get('/orgs/:orgId/campaigns', { preHandler: requireOrg('campaign:read', { ...adv, allowSuspended: true }), schema: { tags: ['campaigns'], params: orgParams, querystring: listQuery } }, async (req) => {
    const q = queryOf(req, listQuery);
    const where = ['org_id = $1'];
    const params: unknown[] = [req.org!.id];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); } else where.push(`status <> 'archived'`);
    if (q.q) { params.push(`%${q.q}%`); where.push(`name ILIKE $${params.length}`); }
    const total = Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM campaigns WHERE ${where.join(' AND ')}`, params)).rows[0]!.n);
    const rows = (await db.query(`SELECT * FROM campaigns WHERE ${where.join(' AND ')} ORDER BY ${orderBy(q, { name: 'name', created: 'created_at', status: 'status', spend: 'spent_micros', start: 'start_at' }, 'created')} LIMIT ${q.pageSize} OFFSET ${offset(q)}`, params)).rows;
    return { data: rows.map((r) => serializeCampaign(r)), meta: pageMeta(q, total) };
  });

  app.post('/orgs/:orgId/campaigns', { config: mgmt, preHandler: requireOrg('campaign:write', adv), schema: { tags: ['campaigns'], params: orgParams, body: campaignBody } }, async (req, reply) => {
    const user = requireUser(req);
    const b = bodyOf(req, campaignBody);
    const s = await app.ctx.settings.get();
    const { rate, lifetime, daily } = validateCampaignRules(b, s);
    const created = await tx(app.ctx, async (c) => {
      const row = (await c.query(
        `INSERT INTO campaigns (org_id, name, pricing_model, rate_micros, currency, lifetime_budget_micros, daily_budget_micros, max_impressions, max_clicks, timezone, start_at, end_at, pacing, priority, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
        [req.org!.id, b.name, b.pricingModel, rate.toString(), req.org!.currency, lifetime.toString(), daily?.toString() ?? null, b.maxImpressions ?? null, b.maxClicks ?? null, b.timezone, b.startAt, b.endAt ?? null, b.pacing, b.priority, user.id])).rows[0];
      await writeTargetingAndCaps(c, row.id, b);
      await recordHistory(c, row.id, user.id, 'created', null, b);
      await audit(c, req, { action: 'campaign.create', resourceType: 'campaign', resourceId: row.id, orgId: req.org!.id, after: b });
      return row.id as string;
    });
    return reply.status(201).send({ data: await loadCampaign(db, created) });
  });

  app.get('/orgs/:orgId/campaigns/:id', { preHandler: requireOrg('campaign:read', { ...adv, allowSuspended: true }), schema: { tags: ['campaigns'], params: orgIdParams } }, async (req) => {
    const c = await loadCampaign(db, paramsOf(req, orgIdParams).id, req.org!.id);
    if (!c) throw notFound();
    return { data: c };
  });

  app.patch('/orgs/:orgId/campaigns/:id', { config: mgmt, preHandler: requireOrg('campaign:write', adv), schema: { tags: ['campaigns'], params: orgIdParams, body: campaignPatch } }, async (req) => {
    const user = requireUser(req);
    const { id } = paramsOf(req, orgIdParams);
    const patch = bodyOf(req, campaignPatch);
    const s = await app.ctx.settings.get();
    await tx(app.ctx, async (c) => {
      const before = await loadCampaign(c, id, req.org!.id);
      if (!before) throw notFound();
      const locked = (await c.query('SELECT status FROM campaigns WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (['completed', 'archived', 'suspended', 'pending_approval'].includes(locked.status)) throw conflict(`A ${locked.status.replace('_', ' ')} campaign cannot be edited`);
      if (patch.pricingModel && patch.pricingModel !== before.pricingModel && before.status !== 'draft' && before.status !== 'rejected') throw conflict('The pricing model can only change before approval');
      const merged: CampaignInput = {
        name: patch.name ?? before.name,
        pricingModel: patch.pricingModel ?? before.pricingModel,
        rate: patch.rate ?? formatMicros(before.rateMicros, 6),
        lifetimeBudget: patch.lifetimeBudget ?? formatMicros(before.lifetimeBudgetMicros, 6),
        dailyBudget: patch.dailyBudget !== undefined ? patch.dailyBudget : before.dailyBudgetMicros ? formatMicros(before.dailyBudgetMicros, 6) : null,
        maxImpressions: patch.maxImpressions !== undefined ? patch.maxImpressions : before.maxImpressions ? Number(before.maxImpressions) : null,
        maxClicks: patch.maxClicks !== undefined ? patch.maxClicks : before.maxClicks ? Number(before.maxClicks) : null,
        timezone: patch.timezone ?? before.timezone,
        startAt: patch.startAt ?? new Date(before.startAt).toISOString(),
        endAt: patch.endAt !== undefined ? patch.endAt : before.endAt ? new Date(before.endAt).toISOString() : null,
        pacing: patch.pacing ?? before.pacing,
        priority: patch.priority ?? before.priority,
        targeting: patch.targeting ?? before.targeting!,
        caps: patch.caps ?? before.caps,
      };
      const { rate, lifetime, daily } = validateCampaignRules(merged, s);
      if (lifetime < BigInt(before.spentMicros)) throw badRequest('Lifetime budget cannot be lower than the amount already spent');
      const approved = ['active', 'scheduled', 'paused'].includes(before.status);
      if (approved && rate !== BigInt(before.rateMicros)) throw conflict('The rate of an approved campaign cannot change; duplicate the campaign instead');
      // Targeting changes on an approved campaign require another review.
      const targetingChanged = patch.targeting !== undefined && JSON.stringify(patch.targeting) !== JSON.stringify(before.targeting);
      const newStatus: CampaignStatus = approved && targetingChanged ? 'pending_approval' : before.status as CampaignStatus;
      await c.query(
        `UPDATE campaigns SET name = $2, pricing_model = $3, rate_micros = $4, lifetime_budget_micros = $5, daily_budget_micros = $6, max_impressions = $7, max_clicks = $8,
           timezone = $9, start_at = $10, end_at = $11, pacing = $12, priority = $13, status = $14, version = version + 1, updated_at = now(),
           submitted_at = CASE WHEN $14 = 'pending_approval' AND status <> 'pending_approval' THEN now() ELSE submitted_at END
         WHERE id = $1`,
        [id, merged.name, merged.pricingModel, rate.toString(), lifetime.toString(), daily?.toString() ?? null, merged.maxImpressions ?? null, merged.maxClicks ?? null, merged.timezone, merged.startAt, merged.endAt ?? null, merged.pacing, merged.priority, newStatus]);
      await writeTargetingAndCaps(c, id, merged);
      if (BigInt(before.reservedMicros) > 0n) {
        if (lifetime > BigInt(before.reservedMicros)) await reserveCampaignBudget(c, id, { type: 'user', userId: user.id });
        else await releaseExcessReserve(c, id, { type: 'user', userId: user.id });
      }
      const after = await loadCampaign(c, id);
      await recordHistory(c, id, user.id, newStatus !== before.status ? 'edited_resubmitted' : 'edited', before, after);
      await audit(c, req, { action: 'campaign.update', resourceType: 'campaign', resourceId: id, orgId: req.org!.id, before, after });
    });
    invalidateServingCache(app.ctx);
    return { data: await loadCampaign(db, id) };
  });

  app.post('/orgs/:orgId/campaigns/:id/duplicate', { config: mgmt, preHandler: requireOrg('campaign:write', adv), schema: { tags: ['campaigns'], params: orgIdParams } }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = paramsOf(req, orgIdParams);
    const newId = await tx(app.ctx, async (c) => {
      const src = (await c.query('SELECT * FROM campaigns WHERE id = $1 AND org_id = $2', [id, req.org!.id])).rows[0];
      if (!src) throw notFound();
      const start = new Date(Math.max(Date.now(), new Date(src.start_at).getTime()));
      const end = src.end_at ? new Date(start.getTime() + (new Date(src.end_at).getTime() - new Date(src.start_at).getTime())) : null;
      const row = (await c.query(
        `INSERT INTO campaigns (org_id, name, pricing_model, rate_micros, currency, lifetime_budget_micros, daily_budget_micros, max_impressions, max_clicks, timezone, start_at, end_at, pacing, priority, created_by)
         SELECT org_id, left('Copy of ' || name, 160), pricing_model, rate_micros, currency, lifetime_budget_micros, daily_budget_micros, max_impressions, max_clicks, timezone, $3, $4, pacing, priority, $2 FROM campaigns WHERE id = $1 RETURNING id`,
        [id, user.id, start, end])).rows[0];
      await c.query(`INSERT INTO campaign_targeting SELECT $2, countries, devices, site_categories, keywords, include_site_ids, exclude_site_ids, include_unit_ids, exclude_unit_ids, require_personalized FROM campaign_targeting WHERE campaign_id = $1`, [id, row.id]);
      await c.query(`INSERT INTO campaign_caps (campaign_id, scope, max_impressions, window_seconds) SELECT $2, scope, max_impressions, window_seconds FROM campaign_caps WHERE campaign_id = $1`, [id, row.id]);
      await c.query(`INSERT INTO creatives (campaign_id, org_id, name, format, headline, body, cta, asset_id, width, height, destination_url, display_url, alt_text, created_by)
                     SELECT $2, org_id, name, format, headline, body, cta, asset_id, width, height, destination_url, display_url, alt_text, $3 FROM creatives WHERE campaign_id = $1 AND status <> 'archived'`, [id, row.id, user.id]);
      await recordHistory(c, row.id, user.id, 'duplicated', null, { from: id });
      await audit(c, req, { action: 'campaign.duplicate', resourceType: 'campaign', resourceId: row.id, orgId: req.org!.id, after: { from: id } });
      return row.id as string;
    });
    return reply.status(201).send({ data: await loadCampaign(db, newId) });
  });

  const transition = (action: 'submit' | 'pause' | 'resume' | 'archive') =>
    app.post(`/orgs/:orgId/campaigns/:id/${action}`, { config: mgmt, preHandler: requireOrg('campaign:write', adv), schema: { tags: ['campaigns'], params: orgIdParams } }, async (req) => {
      const user = requireUser(req);
      const { id } = paramsOf(req, orgIdParams);
      const s = await app.ctx.settings.get();
      await tx(app.ctx, async (c) => {
        const row = (await c.query('SELECT * FROM campaigns WHERE id = $1 AND org_id = $2 FOR UPDATE', [id, req.org!.id])).rows[0];
        if (!row) throw notFound();
        if (!ADVERTISER_CAMPAIGN_TRANSITIONS[action]!.includes(row.status)) throw conflict(`Cannot ${action} a campaign that is ${row.status.replace('_', ' ')}`);
        let next: CampaignStatus;
        if (action === 'submit') {
          if (row.end_at && new Date(row.end_at) <= new Date()) throw badRequest('The campaign end date has passed');
          const creatives = (await c.query(`SELECT id, status FROM creatives WHERE campaign_id = $1 AND status <> 'archived'`, [id])).rows;
          if (creatives.length === 0) throw badRequest('Add at least one creative before submitting');
          await c.query(`UPDATE creatives SET status = 'pending_review', updated_at = now() WHERE campaign_id = $1 AND status IN ('draft', 'rejected')`, [id]);
          for (const cr of creatives) {
            const full = (await c.query('SELECT c.*, a.storage_key FROM creatives c LEFT JOIN assets a ON a.id = c.asset_id WHERE c.id = $1', [cr.id])).rows[0];
            await c.query('INSERT INTO creative_versions (creative_id, version, snapshot, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (creative_id, version) DO NOTHING', [cr.id, full.version, JSON.stringify(creativeSnapshot(full, full.storage_key)), user.id]);
          }
          await reserveCampaignBudget(c, id, { type: 'user', userId: user.id }); // throws 402 when funds are insufficient
          next = 'pending_approval';
          await c.query(`UPDATE campaigns SET status = $2, submitted_at = now(), status_reason = NULL, updated_at = now() WHERE id = $1`, [id, next]);
        } else if (action === 'pause') {
          next = 'paused';
          await c.query(`UPDATE campaigns SET status = 'paused', updated_at = now() WHERE id = $1`, [id]);
        } else if (action === 'resume') {
          if (row.end_at && new Date(row.end_at) <= new Date()) throw badRequest('The campaign end date has passed');
          if (BigInt(row.spent_micros) >= BigInt(row.lifetime_budget_micros)) throw badRequest('The campaign budget is exhausted. Increase the budget to resume.');
          next = liveStatus(row.start_at);
          await c.query(`UPDATE campaigns SET status = $2, updated_at = now() WHERE id = $1`, [id, next]);
        } else {
          next = 'archived';
          await c.query(`UPDATE campaigns SET status = 'archived', updated_at = now() WHERE id = $1`, [id]);
          await releaseCampaignReserve(c, id, { type: 'user', userId: user.id }, 'Campaign archived', s.publishers.earningsHoldDays);
        }
        await recordHistory(c, id, user.id, action, { status: row.status }, { status: next });
        await audit(c, req, { action: `campaign.${action}`, resourceType: 'campaign', resourceId: id, orgId: req.org!.id, before: { status: row.status }, after: { status: next } });
      });
      if (action === 'submit') await notifyStaff(app.ctx, ['super_admin', 'admin', 'ad_ops'], 'Campaign submitted for review', `A campaign from ${req.org!.name} is waiting for approval.`, `/admin/campaigns/${id}`).catch(() => undefined);
      invalidateServingCache(app.ctx);
      return { data: await loadCampaign(db, id) };
    });
  (['submit', 'pause', 'resume', 'archive'] as const).forEach(transition);

  app.get('/orgs/:orgId/campaigns/:id/history', { preHandler: requireOrg('campaign:read', { ...adv, allowSuspended: true }), schema: { tags: ['campaigns'], params: orgIdParams } }, async (req) => {
    const { id } = paramsOf(req, orgIdParams);
    const exists = await db.query('SELECT 1 FROM campaigns WHERE id = $1 AND org_id = $2', [id, req.org!.id]);
    if (!exists.rowCount) throw notFound();
    const rows = (await db.query(`SELECT h.id, h.action, h.before, h.after, h.reason, h.created_at, u.name AS actor_name FROM campaign_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.campaign_id = $1 ORDER BY h.created_at DESC LIMIT 200`, [id])).rows;
    return { data: rows };
  });

  // ---------------------------------------------------------------- creatives
  app.post('/orgs/:orgId/assets', { config: mgmt, preHandler: requireOrg('creative:write', adv), schema: { tags: ['creatives'], params: orgParams, consumes: ['multipart/form-data'] } }, async (req, reply) => {
    const user = requireUser(req);
    const file = await req.file();
    if (!file) throw badRequest('Attach an image file');
    const buf = await file.toBuffer();
    const s = await app.ctx.settings.get();
    const info = inspectImage(buf, s);
    const key = `creatives/${req.org!.id}/${info.sha256}.${info.ext}`;
    await app.ctx.storage.put(key, buf, info.mime);
    const row = (await db.query(
      `INSERT INTO assets (org_id, sha256, mime_type, size_bytes, width, height, storage_key, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (storage_key) DO UPDATE SET storage_key = EXCLUDED.storage_key RETURNING id, width, height, mime_type, size_bytes, storage_key`,
      [req.org!.id, info.sha256, info.mime, info.size, info.width, info.height, key, user.id])).rows[0];
    return reply.status(201).send({ data: { id: row.id, width: row.width, height: row.height, mimeType: row.mime_type, sizeBytes: row.size_bytes, url: app.ctx.storage.publicUrl(row.storage_key) } });
  });

  async function creativeWithUrl(id: string) {
    const r = (await db.query('SELECT c.*, a.storage_key FROM creatives c LEFT JOIN assets a ON a.id = c.asset_id WHERE c.id = $1', [id])).rows[0];
    return serializeCreative(r, r.storage_key ? app.ctx.storage.publicUrl(r.storage_key) : null);
  }

  app.get('/orgs/:orgId/campaigns/:id/creatives', { preHandler: requireOrg('creative:read', { ...adv, allowSuspended: true }), schema: { tags: ['creatives'], params: orgIdParams } }, async (req) => {
    const { id } = paramsOf(req, orgIdParams);
    const rows = (await db.query(`SELECT c.*, a.storage_key FROM creatives c LEFT JOIN assets a ON a.id = c.asset_id WHERE c.campaign_id = $1 AND c.org_id = $2 ORDER BY c.created_at`, [id, req.org!.id])).rows;
    return { data: rows.map((r) => serializeCreative(r, r.storage_key ? app.ctx.storage.publicUrl(r.storage_key) : null)) };
  });

  async function validateCreativeInput(orgId: string, format: 'image' | 'text' | 'native', b: Partial<z.infer<typeof creativeBody>>) {
    const s = await app.ctx.settings.get();
    if (!s.creatives.allowedFormats.includes(format)) throw badRequest(`${format} creatives are not currently accepted`);
    const destination = b.destinationUrl !== undefined ? validateDestinationUrl(b.destinationUrl, s, await blockedDomains(), !app.ctx.config.isProd && app.ctx.config.NODE_ENV === 'development') : undefined;
    let asset: { id: string; width: number; height: number } | null = null;
    if (b.assetId) {
      asset = (await db.query('SELECT id, width, height FROM assets WHERE id = $1 AND org_id = $2', [b.assetId, orgId])).rows[0] ?? null;
      if (!asset) throw badRequest('Unknown image asset');
    }
    return { destination, asset };
  }

  app.post('/orgs/:orgId/campaigns/:id/creatives', { config: mgmt, preHandler: requireOrg('creative:write', adv), schema: { tags: ['creatives'], params: orgIdParams, body: creativeBody } }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = paramsOf(req, orgIdParams);
    const b = bodyOf(req, creativeBody);
    const camp = (await db.query('SELECT status FROM campaigns WHERE id = $1 AND org_id = $2', [id, req.org!.id])).rows[0];
    if (!camp) throw notFound();
    if (['archived', 'completed'].includes(camp.status)) throw conflict('Creatives cannot be added to this campaign');
    const { destination, asset } = await validateCreativeInput(req.org!.id, b.format, b);
    if (b.format === 'image' && !asset) throw badRequest('Image creatives need an uploaded image');
    if (b.format === 'text' && !b.headline) throw badRequest('Text creatives need a headline');
    if (b.format === 'native' && (!asset || !b.headline || !b.sponsorName)) throw badRequest('Native ads need an image, a headline and the sponsor name shown to readers');
    const status = camp.status === 'draft' || camp.status === 'rejected' ? 'draft' : 'pending_review';
    const row = await tx(app.ctx, async (c) => {
      const cr = (await c.query(
        `INSERT INTO creatives (campaign_id, org_id, name, format, status, headline, body, cta, asset_id, width, height, destination_url, display_url, alt_text, sponsor_name, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
        [id, req.org!.id, b.name, b.format, status, b.headline ?? null, b.body ?? null, b.cta ?? null, asset?.id ?? null, asset?.width ?? null, asset?.height ?? null, destination, b.displayUrl ?? null, b.altText ?? null, b.format === 'native' ? b.sponsorName! : null, user.id])).rows[0];
      const key = asset ? (await c.query('SELECT storage_key FROM assets WHERE id = $1', [asset.id])).rows[0].storage_key : null;
      await c.query('INSERT INTO creative_versions (creative_id, version, snapshot, created_by) VALUES ($1, 1, $2, $3)', [cr.id, JSON.stringify(creativeSnapshot(cr, key)), user.id]);
      await audit(c, req, { action: 'creative.create', resourceType: 'creative', resourceId: cr.id, orgId: req.org!.id, after: b });
      return cr;
    });
    if (status === 'pending_review') await notifyStaff(app.ctx, ['super_admin', 'admin', 'ad_ops'], 'Creative awaiting review', `${req.org!.name} added a creative to a live campaign.`, `/admin/creatives`).catch(() => undefined);
    return reply.status(201).send({ data: await creativeWithUrl(row.id) });
  });

  app.patch('/orgs/:orgId/creatives/:id', { config: mgmt, preHandler: requireOrg('creative:write', adv), schema: { tags: ['creatives'], params: orgIdParams, body: creativePatch } }, async (req) => {
    const user = requireUser(req);
    const { id } = paramsOf(req, orgIdParams);
    const b = bodyOf(req, creativePatch);
    await tx(app.ctx, async (c) => {
      const cr = (await c.query('SELECT c.*, k.status AS campaign_status FROM creatives c JOIN campaigns k ON k.id = c.campaign_id WHERE c.id = $1 AND c.org_id = $2 FOR UPDATE OF c', [id, req.org!.id])).rows[0];
      if (!cr) throw notFound();
      if (cr.status === 'archived') throw conflict('Archived creatives cannot be edited');
      const { destination, asset } = await validateCreativeInput(req.org!.id, cr.format, b);
      if (cr.format === 'image' && b.assetId === undefined && !cr.asset_id) throw badRequest('Image creatives need an uploaded image');
      if (cr.format !== 'native' && b.sponsorName !== undefined) throw badRequest('Only native ads have a sponsor name');
      const draftCampaign = ['draft', 'rejected'].includes(cr.campaign_status);
      // Editing creates a new version. A previously approved version keeps serving until the new one is approved.
      const status = draftCampaign ? 'draft' : 'pending_review';
      const upd = (await c.query(
        `UPDATE creatives SET name = COALESCE($2, name), headline = COALESCE($3, headline), body = COALESCE($4, body), cta = COALESCE($5, cta),
           asset_id = COALESCE($6, asset_id), width = COALESCE($7, width), height = COALESCE($8, height), destination_url = COALESCE($9, destination_url),
           display_url = COALESCE($10, display_url), alt_text = COALESCE($11, alt_text), sponsor_name = COALESCE($13, sponsor_name), version = version + 1, status = $12, rejection_reason = NULL, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, b.name ?? null, b.headline ?? null, b.body ?? null, b.cta ?? null, asset?.id ?? null, asset?.width ?? null, asset?.height ?? null, destination ?? null, b.displayUrl ?? null, b.altText ?? null, status, b.sponsorName ?? null])).rows[0];
      const key = upd.asset_id ? (await c.query('SELECT storage_key FROM assets WHERE id = $1', [upd.asset_id])).rows[0].storage_key : null;
      await c.query('INSERT INTO creative_versions (creative_id, version, snapshot, created_by) VALUES ($1, $2, $3, $4)', [id, upd.version, JSON.stringify(creativeSnapshot(upd, key)), user.id]);
      await audit(c, req, { action: 'creative.update', resourceType: 'creative', resourceId: id, orgId: req.org!.id, before: cr, after: upd });
    });
    invalidateServingCache(app.ctx);
    return { data: await creativeWithUrl(id) };
  });

  app.post('/orgs/:orgId/creatives/:id/archive', { config: mgmt, preHandler: requireOrg('creative:write', adv), schema: { tags: ['creatives'], params: orgIdParams } }, async (req) => {
    const { id } = paramsOf(req, orgIdParams);
    const r = await db.query(`UPDATE creatives SET status = 'archived', updated_at = now() WHERE id = $1 AND org_id = $2 AND status <> 'archived' RETURNING id`, [id, req.org!.id]);
    if (!r.rowCount) throw notFound();
    await audit(db, req, { action: 'creative.archive', resourceType: 'creative', resourceId: id, orgId: req.org!.id });
    invalidateServingCache(app.ctx);
    return { ok: true };
  });

  app.get('/orgs/:orgId/creatives/:id/versions', { preHandler: requireOrg('creative:read', { ...adv, allowSuspended: true }), schema: { tags: ['creatives'], params: orgIdParams } }, async (req) => {
    const { id } = paramsOf(req, orgIdParams);
    const owns = await db.query('SELECT 1 FROM creatives WHERE id = $1 AND org_id = $2', [id, req.org!.id]);
    if (!owns.rowCount) throw notFound();
    const versions = (await db.query('SELECT version, snapshot, created_at FROM creative_versions WHERE creative_id = $1 ORDER BY version DESC', [id])).rows;
    const reviews = (await db.query('SELECT version, decision, reason, created_at FROM creative_reviews WHERE creative_id = $1 ORDER BY created_at DESC', [id])).rows;
    return { data: { versions, reviews } };
  });
}
