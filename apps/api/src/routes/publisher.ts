import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { balance, requestPayout } from '@blissnova/billing';
import { toMicros } from '@blissnova/shared';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { randomToken } from '../lib/crypto';
import { bodyOf, moneyString, orgIdParams, orgParams, paramsOf } from '../lib/http';
import { tx } from '../lib/tx';
import { requireOrg, requireUser } from '../plugins/auth';
import { checkVerification, normalizeDomain, verificationInstructions } from '../services/verification';
import { notifyStaff } from '../services/notifications';
import { invalidateServingCache } from '../services/serving';

const CATEGORIES = ['general', 'news', 'technology', 'business', 'finance', 'lifestyle', 'entertainment', 'sports', 'education', 'health', 'travel', 'food', 'automotive', 'gaming', 'parenting', 'real_estate', 'science', 'other'] as const;
const siteBody = z.object({
  name: z.string().trim().min(1).max(160),
  domain: z.string().trim().min(3).max(253),
  category: z.enum(CATEGORIES).default('general'),
  allowedDomains: z.array(z.string().max(253)).max(20).default([]),
});
const sitePatch = siteBody.partial().omit({ domain: true });
const unitBody = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/, 'Use lowercase letters, numbers, hyphens and underscores'),
  name: z.string().trim().min(1).max(120),
  formats: z.array(z.enum(['image', 'text'])).min(1).default(['image', 'text']),
  width: z.number().int().min(1).max(2000).nullable().optional(),
  height: z.number().int().min(1).max(2000).nullable().optional(),
  responsive: z.boolean().default(true),
  position: z.enum(['header', 'sidebar', 'in_content', 'footer', 'other']).default('in_content'),
});
const unitPatch = unitBody.partial().omit({ key: true });
const siteUnitParams = z.object({ orgId: z.uuid(), siteId: z.uuid() });
const verifyBody = z.object({ method: z.enum(['dns_txt', 'html_file', 'meta_tag']) });
const payoutProfileBody = z.object({ method: z.enum(['bank_transfer', 'paypal', 'other']), displayLabel: z.string().trim().min(3).max(120) });
const payoutBody = z.object({ amount: moneyString });

export function siteKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return 'pk_' + Array.from(randomBytes(24), (b) => alphabet[b % alphabet.length]).join('');
}

export function serializeSite(s: Record<string, any>) {
  return {
    id: s.id, name: s.name, domain: s.domain, allowedDomains: s.allowed_domains, category: s.category, status: s.status, statusReason: s.status_reason,
    siteKey: s.public_key, verifiedAt: s.verified_at, approvedAt: s.approved_at, allowedFormats: s.allowed_formats, revenueShareBps: s.revenue_share_bps, createdAt: s.created_at,
  };
}

export function serializeUnit(u: Record<string, any>) {
  return { id: u.id, siteId: u.site_id, key: u.key, name: u.name, formats: u.formats, width: u.width, height: u.height, responsive: u.responsive, position: u.position, status: u.status, adminBlocked: u.admin_blocked, createdAt: u.created_at };
}

export async function publisherRoutes(app: FastifyInstance) {
  const { db, config } = app.ctx;
  const mgmt = { rateLimit: { bucket: 'management' as const } };
  const pub = { type: 'publisher' as const };

  function cleanAllowed(main: string, list: string[]) {
    const out: string[] = [];
    for (const raw of list) {
      const d = normalizeDomain(raw);
      if (!d) throw badRequest(`Invalid domain: ${raw}`);
      // Extra hostnames must be subdomains of the verified domain (or localhost outside production) so a publisher cannot claim someone else's site.
      if (!(d === main || d.endsWith(`.${main}`) || (d === 'localhost' && !config.isProd))) throw badRequest(`${d} is not a subdomain of ${main}`);
      if (!out.includes(d)) out.push(d);
    }
    return out;
  }

  async function siteDetail(id: string) {
    const s = (await db.query('SELECT * FROM sites WHERE id = $1', [id])).rows[0];
    const v = (await db.query(`SELECT method, token, status, last_checked_at, last_error, verified_at FROM site_verifications WHERE site_id = $1 AND status <> 'superseded' ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
    const settings = await app.ctx.settings.get();
    const orgShare = (await db.query('SELECT revenue_share_bps FROM organizations WHERE id = $1', [s.org_id])).rows[0]?.revenue_share_bps;
    return {
      ...serializeSite(s),
      effectiveRevenueShareBps: s.revenue_share_bps ?? orgShare ?? settings.publishers.defaultRevenueShareBps,
      verification: v ? { token: v.token, lastMethod: v.method, status: v.status, lastCheckedAt: v.last_checked_at, lastError: v.last_error, verifiedAt: v.verified_at, methods: verificationInstructions(s.domain, v.token) } : null,
    };
  }

  // ---------------------------------------------------------------- sites
  app.get('/orgs/:orgId/sites', { preHandler: requireOrg('site:read', { ...pub, allowSuspended: true }), schema: { tags: ['publisher sites'], params: orgParams } }, async (req) => {
    const rows = (await db.query(`SELECT s.*, (SELECT count(*) FROM ad_units u WHERE u.site_id = s.id AND u.status <> 'archived')::int AS unit_count FROM sites s WHERE s.org_id = $1 ORDER BY s.created_at DESC`, [req.org!.id])).rows;
    return { data: rows.map((r) => ({ ...serializeSite(r), unitCount: r.unit_count })) };
  });

  app.post('/orgs/:orgId/sites', { config: mgmt, preHandler: requireOrg('site:write', pub), schema: { tags: ['publisher sites'], params: orgParams, body: siteBody } }, async (req, reply) => {
    const b = bodyOf(req, siteBody);
    const domain = normalizeDomain(b.domain);
    if (!domain || (domain === 'localhost' && config.isProd)) throw badRequest('Enter a valid public domain such as example.com');
    const allowed = cleanAllowed(domain, b.allowedDomains);
    const id = await tx(app.ctx, async (c) => {
      const dup = await c.query(`SELECT org_id FROM sites WHERE domain = $1 AND status <> 'rejected'`, [domain]);
      if (dup.rowCount) throw conflict('This domain is already registered on the network. Contact support if you own it.');
      const s = (await c.query(`INSERT INTO sites (org_id, name, domain, allowed_domains, category, public_key) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [req.org!.id, b.name, domain, allowed, b.category, siteKey()])).rows[0];
      await c.query(`INSERT INTO site_verifications (site_id, method, token) VALUES ($1, 'dns_txt', $2)`, [s.id, `bnv-${randomToken(18)}`]);
      await audit(c, req, { action: 'site.create', resourceType: 'site', resourceId: s.id, orgId: req.org!.id, after: { ...b, domain } });
      return s.id as string;
    });
    return reply.status(201).send({ data: await siteDetail(id) });
  });

  async function ownSite(orgId: string, id: string) {
    const s = (await db.query('SELECT * FROM sites WHERE id = $1 AND org_id = $2', [id, orgId])).rows[0];
    if (!s) throw notFound();
    return s;
  }

  app.get('/orgs/:orgId/sites/:id', { preHandler: requireOrg('site:read', { ...pub, allowSuspended: true }), schema: { tags: ['publisher sites'], params: orgIdParams } }, async (req) => {
    const s = await ownSite(req.org!.id, paramsOf(req, orgIdParams).id);
    return { data: await siteDetail(s.id) };
  });

  app.patch('/orgs/:orgId/sites/:id', { config: mgmt, preHandler: requireOrg('site:write', pub), schema: { tags: ['publisher sites'], params: orgIdParams, body: sitePatch } }, async (req) => {
    const s = await ownSite(req.org!.id, paramsOf(req, orgIdParams).id);
    const b = bodyOf(req, sitePatch);
    const allowed = b.allowedDomains ? cleanAllowed(s.domain, b.allowedDomains) : s.allowed_domains;
    const after = (await db.query(`UPDATE sites SET name = COALESCE($2, name), category = COALESCE($3, category), allowed_domains = $4, updated_at = now() WHERE id = $1 RETURNING *`, [s.id, b.name ?? null, b.category ?? null, allowed])).rows[0];
    await audit(db, req, { action: 'site.update', resourceType: 'site', resourceId: s.id, orgId: req.org!.id, before: serializeSite(s), after: serializeSite(after) });
    invalidateServingCache(app.ctx);
    return { data: await siteDetail(s.id) };
  });

  app.post('/orgs/:orgId/sites/:id/verify', { config: { rateLimit: { bucket: 'management', limit: 20 } }, preHandler: requireOrg('site:write', pub), schema: { tags: ['publisher sites'], params: orgIdParams, body: verifyBody } }, async (req) => {
    const s = await ownSite(req.org!.id, paramsOf(req, orgIdParams).id);
    const { method } = bodyOf(req, verifyBody);
    if (s.verified_at) return { data: await siteDetail(s.id), verified: true };
    const v = (await db.query(`SELECT * FROM site_verifications WHERE site_id = $1 AND status <> 'superseded' ORDER BY created_at DESC LIMIT 1`, [s.id])).rows[0];
    if (!v) throw conflict('No verification challenge exists for this site');
    const outcome = await checkVerification(method, s.domain, v.token, config);
    const settings = await app.ctx.settings.get();
    if (!outcome.ok) {
      await db.query(`UPDATE site_verifications SET method = $2, attempts = attempts + 1, last_checked_at = now(), last_error = $3, status = 'failed' WHERE id = $1`, [v.id, method, outcome.error]);
      return { data: await siteDetail(s.id), verified: false, error: outcome.error };
    }
    const nextStatus = settings.publishers.requireSiteReview ? 'pending_review' : 'approved';
    await tx(app.ctx, async (c) => {
      await c.query(`UPDATE site_verifications SET method = $2, attempts = attempts + 1, last_checked_at = now(), last_error = NULL, status = 'verified', verified_at = now() WHERE id = $1`, [v.id, method]);
      await c.query(`UPDATE sites SET verified_at = now(), status = CASE WHEN status = 'pending_verification' THEN $2 ELSE status END, approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END, updated_at = now() WHERE id = $1`, [s.id, nextStatus]);
      await audit(c, req, { action: 'site.verified', resourceType: 'site', resourceId: s.id, orgId: req.org!.id, after: { method } });
    });
    if (nextStatus === 'pending_review') await notifyStaff(app.ctx, ['super_admin', 'admin', 'ad_ops'], 'Site awaiting review', `${s.domain} was verified and needs review.`, `/admin/sites/${s.id}`).catch(() => undefined);
    invalidateServingCache(app.ctx);
    return { data: await siteDetail(s.id), verified: true };
  });

  app.post('/orgs/:orgId/sites/:id/verification-token', { config: mgmt, preHandler: requireOrg('site:write', pub), schema: { tags: ['publisher sites'], params: orgIdParams } }, async (req) => {
    const s = await ownSite(req.org!.id, paramsOf(req, orgIdParams).id);
    if (s.verified_at) throw conflict('This site is already verified');
    await db.query(`UPDATE site_verifications SET status = 'superseded' WHERE site_id = $1`, [s.id]);
    await db.query(`INSERT INTO site_verifications (site_id, method, token) VALUES ($1, 'dns_txt', $2)`, [s.id, `bnv-${randomToken(18)}`]);
    return { data: await siteDetail(s.id) };
  });

  app.get('/orgs/:orgId/sites/:id/tag', { preHandler: requireOrg('site:read', { ...pub, allowSuspended: true }), schema: { tags: ['publisher sites'], params: orgIdParams } }, async (req) => {
    const s = await ownSite(req.org!.id, paramsOf(req, orgIdParams).id);
    const units = (await db.query(`SELECT * FROM ad_units WHERE site_id = $1 AND status <> 'archived' ORDER BY created_at`, [s.id])).rows;
    const loader = `<script async src="${config.PUBLIC_API_URL}/sdk/v1/bn.js" data-site-key="${s.public_key}" data-api="${config.PUBLIC_API_URL}"></script>`;
    return {
      data: {
        siteKey: s.public_key,
        loader,
        units: units.map((u) => ({ key: u.key, name: u.name, snippet: `<div class="blissnova-ad" data-bn-slot="${u.key}"${u.width && u.height && !u.responsive ? ` style="width:${u.width}px;height:${u.height}px"` : ''}></div>` })),
        wordpress: { shortcode: units[0] ? `[blissnova_ad slot="${units[0].key}"]` : '[blissnova_ad slot="your-slot-key"]', php: units[0] ? `<?php blissnova_ad_render('${units[0].key}'); ?>` : `<?php blissnova_ad_render('your-slot-key'); ?>` },
        consentNote: 'By default the tag requests contextual (non-personalized) ads and sets no cookies. To allow personalization where you have consent, call window.blissnova.setConsent({ personalized: true }) from your consent management platform.',
      },
    };
  });

  // ---------------------------------------------------------------- ad units
  app.get('/orgs/:orgId/sites/:siteId/units', { preHandler: requireOrg('unit:read', { ...pub, allowSuspended: true }), schema: { tags: ['placements'], params: siteUnitParams } }, async (req) => {
    const { siteId } = paramsOf(req, siteUnitParams);
    await ownSite(req.org!.id, siteId);
    const rows = (await db.query(`SELECT * FROM ad_units WHERE site_id = $1 AND status <> 'archived' ORDER BY created_at`, [siteId])).rows;
    return { data: rows.map(serializeUnit) };
  });

  app.post('/orgs/:orgId/sites/:siteId/units', { config: mgmt, preHandler: requireOrg('unit:write', pub), schema: { tags: ['placements'], params: siteUnitParams, body: unitBody } }, async (req, reply) => {
    const { siteId } = paramsOf(req, siteUnitParams);
    const s = await ownSite(req.org!.id, siteId);
    const b = bodyOf(req, unitBody);
    if ((b.width && !b.height) || (!b.width && b.height)) throw badRequest('Provide both width and height, or neither');
    if (b.formats.includes('image') && !b.width && !b.responsive) throw badRequest('Fixed-size image placements need dimensions');
    const bad = b.formats.filter((f) => !s.allowed_formats.includes(f));
    if (bad.length) throw badRequest(`This site is not approved for ${bad.join(', ')} ads`);
    const row = (await db.query(`INSERT INTO ad_units (site_id, key, name, formats, width, height, responsive, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [siteId, b.key, b.name, b.formats, b.width ?? null, b.height ?? null, b.responsive, b.position]).catch((err: { code?: string }) => {
      if (err.code === '23505') throw conflict('A placement with this key already exists on this site');
      throw err;
    })).rows[0];
    await audit(db, req, { action: 'unit.create', resourceType: 'ad_unit', resourceId: row.id, orgId: req.org!.id, after: b });
    invalidateServingCache(app.ctx);
    return reply.status(201).send({ data: serializeUnit(row) });
  });

  async function ownUnit(orgId: string, id: string) {
    const u = (await db.query('SELECT u.* FROM ad_units u JOIN sites s ON s.id = u.site_id WHERE u.id = $1 AND s.org_id = $2', [id, orgId])).rows[0];
    if (!u) throw notFound();
    return u;
  }

  app.patch('/orgs/:orgId/units/:id', { config: mgmt, preHandler: requireOrg('unit:write', pub), schema: { tags: ['placements'], params: orgIdParams, body: unitPatch } }, async (req) => {
    const u = await ownUnit(req.org!.id, paramsOf(req, orgIdParams).id);
    const b = bodyOf(req, unitPatch);
    const after = (await db.query(
      `UPDATE ad_units SET name = COALESCE($2, name), formats = COALESCE($3, formats), width = CASE WHEN $4::boolean THEN $5 ELSE width END, height = CASE WHEN $4::boolean THEN $6 ELSE height END,
         responsive = COALESCE($7, responsive), position = COALESCE($8, position), updated_at = now() WHERE id = $1 RETURNING *`,
      [u.id, b.name ?? null, b.formats ?? null, b.width !== undefined, b.width ?? null, b.height ?? null, b.responsive ?? null, b.position ?? null])).rows[0];
    await audit(db, req, { action: 'unit.update', resourceType: 'ad_unit', resourceId: u.id, orgId: req.org!.id, before: serializeUnit(u), after: serializeUnit(after) });
    invalidateServingCache(app.ctx);
    return { data: serializeUnit(after) };
  });

  for (const [action, status] of [['pause', 'paused'], ['activate', 'active'], ['archive', 'archived']] as const) {
    app.post(`/orgs/:orgId/units/:id/${action}`, { config: mgmt, preHandler: requireOrg('unit:write', pub), schema: { tags: ['placements'], params: orgIdParams } }, async (req) => {
      const u = await ownUnit(req.org!.id, paramsOf(req, orgIdParams).id);
      if (u.status === 'archived') throw conflict('Archived placements cannot be changed');
      const after = (await db.query('UPDATE ad_units SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [u.id, status])).rows[0];
      await audit(db, req, { action: `unit.${action}`, resourceType: 'ad_unit', resourceId: u.id, orgId: req.org!.id, before: { status: u.status }, after: { status } });
      invalidateServingCache(app.ctx);
      return { data: serializeUnit(after) };
    });
  }

  // ---------------------------------------------------------------- earnings & payouts
  app.get('/orgs/:orgId/earnings', { preHandler: requireOrg('earnings:read', { ...pub, allowSuspended: true }), schema: { tags: ['earnings'], params: orgParams } }, async (req) => {
    const cur = req.org!.currency;
    const [pending, available, processing] = await Promise.all([
      balance(db as never, { kind: 'publisher_pending', orgId: req.org!.id }, cur),
      balance(db as never, { kind: 'publisher_available', orgId: req.org!.id }, cur),
      balance(db as never, { kind: 'publisher_payout_processing', orgId: req.org!.id }, cur),
    ]);
    const paid = (await db.query<{ t: string }>(`SELECT COALESCE(sum(amount_micros), 0)::text AS t FROM payouts WHERE org_id = $1 AND status = 'paid'`, [req.org!.id])).rows[0]!.t;
    const unsettled = (await db.query<{ t: string }>(`SELECT COALESCE(sum(publisher_micros), 0)::text AS t FROM ad_events WHERE publisher_org_id = $1 AND billable AND settlement_id IS NULL`, [req.org!.id])).rows[0]!.t;
    const settlements = (await db.query(`SELECT id, event_count, charge_micros, publisher_micros, reversed_publisher_micros, hold_until, finalized_at, created_at FROM settlements WHERE publisher_org_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.org!.id])).rows;
    const settings = await app.ctx.settings.get();
    return {
      data: {
        currency: cur,
        estimatedUnsettledMicros: unsettled,
        pendingMicros: pending.toString(),
        availableMicros: available.toString(),
        processingMicros: processing.toString(),
        paidMicros: paid,
        holdDays: settings.publishers.earningsHoldDays,
        minimumPayoutMicros: settings.publishers.minimumPayoutMicros,
        settlements: settlements.map((s) => ({ id: s.id, events: s.event_count, earningsMicros: s.publisher_micros, reversedMicros: s.reversed_publisher_micros, holdUntil: s.hold_until, finalizedAt: s.finalized_at, createdAt: s.created_at })),
      },
    };
  });

  app.get('/orgs/:orgId/payout-profile', { preHandler: requireOrg('earnings:read', { ...pub, allowSuspended: true }), schema: { tags: ['earnings'], params: orgParams } }, async (req) => {
    const p = (await db.query('SELECT method, display_label, currency, updated_at FROM payout_profiles WHERE org_id = $1', [req.org!.id])).rows[0];
    return { data: p ?? null };
  });

  app.put('/orgs/:orgId/payout-profile', { config: mgmt, preHandler: requireOrg('payout:request', pub), schema: { tags: ['earnings'], params: orgParams, body: payoutProfileBody } }, async (req) => {
    const user = requireUser(req);
    const b = bodyOf(req, payoutProfileBody);
    if (/\d{7,}/.test(b.displayLabel.replace(/\s/g, ''))) throw badRequest('Do not enter full account numbers. Use a masked label such as "Bank transfer ****1234".');
    const before = (await db.query('SELECT * FROM payout_profiles WHERE org_id = $1', [req.org!.id])).rows[0];
    await db.query(`INSERT INTO payout_profiles (org_id, method, display_label, currency, updated_by) VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (org_id) DO UPDATE SET method = EXCLUDED.method, display_label = EXCLUDED.display_label, updated_by = EXCLUDED.updated_by, updated_at = now()`, [req.org!.id, b.method, b.displayLabel, req.org!.currency, user.id]);
    await audit(db, req, { action: 'payout_profile.update', resourceType: 'organization', resourceId: req.org!.id, orgId: req.org!.id, before, after: b });
    return { ok: true };
  });

  app.get('/orgs/:orgId/payouts', { preHandler: requireOrg('earnings:read', { ...pub, allowSuspended: true }), schema: { tags: ['earnings'], params: orgParams } }, async (req) => {
    const rows = (await db.query(`SELECT id, amount_micros, currency, status, method_label, review_reason, failure_reason, provider_ref, created_at, updated_at FROM payouts WHERE org_id = $1 ORDER BY created_at DESC LIMIT 200`, [req.org!.id])).rows;
    return { data: rows };
  });

  app.post('/orgs/:orgId/payouts', { config: mgmt, preHandler: requireOrg('payout:request', pub), schema: { tags: ['earnings'], params: orgParams, body: payoutBody } }, async (req, reply) => {
    const user = requireUser(req);
    if (req.org!.status !== 'approved') throw conflict('Payouts are available after your publisher account is approved');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw badRequest('An Idempotency-Key header is required');
    const settings = await app.ctx.settings.get();
    const amount = toMicros(bodyOf(req, payoutBody).amount);
    const payout = await tx(app.ctx, async (c) => {
      const p = await requestPayout(c, { orgId: req.org!.id, amount, currency: req.org!.currency, userId: user.id, idempotencyKey: `${req.org!.id}:${key}`, minimum: BigInt(settings.publishers.minimumPayoutMicros) });
      await audit(c, req, { action: 'payout.request', resourceType: 'payout', resourceId: p.id, orgId: req.org!.id, after: { amount: amount.toString() } });
      return p;
    });
    await notifyStaff(app.ctx, ['super_admin', 'admin', 'finance'], 'Payout requested', `${req.org!.name} requested a payout.`, `/admin/payouts`).catch(() => undefined);
    return reply.status(201).send({ data: payout });
  });

  app.post('/orgs/:orgId/payouts/:id/cancel', { config: mgmt, preHandler: requireOrg('payout:request', pub), schema: { tags: ['earnings'], params: orgIdParams } }, async (req) => {
    const { id } = paramsOf(req, orgIdParams);
    const r = await db.query(`UPDATE payouts SET status = 'cancelled', updated_at = now() WHERE id = $1 AND org_id = $2 AND status = 'requested' RETURNING id`, [id, req.org!.id]);
    if (!r.rowCount) throw conflict('Only payouts that have not been reviewed can be cancelled');
    await audit(db, req, { action: 'payout.cancel', resourceType: 'payout', resourceId: id, orgId: req.org!.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- invalid-traffic cases & appeals
  app.get('/orgs/:orgId/fraud-cases', { preHandler: requireOrg('report:read', { allowSuspended: true }), schema: { tags: ['invalid traffic'], params: orgParams } }, async (req) => {
    const rows = (await db.query(
      `SELECT f.id, f.title, f.status, f.severity, f.outcome, f.appeal_text, f.created_at, f.resolved_at FROM fraud_cases f
       WHERE (f.subject_type = 'organization' AND f.subject_id = $1) OR (f.subject_type = 'site' AND f.subject_id IN (SELECT id FROM sites WHERE org_id = $1))
          OR (f.subject_type = 'campaign' AND f.subject_id IN (SELECT id FROM campaigns WHERE org_id = $1)) OR (f.subject_type = 'unit' AND f.subject_id IN (SELECT u.id FROM ad_units u JOIN sites s ON s.id = u.site_id WHERE s.org_id = $1))
       ORDER BY f.created_at DESC`, [req.org!.id])).rows;
    return { data: rows };
  });

  app.post('/orgs/:orgId/fraud-cases/:id/appeal', { config: mgmt, preHandler: requireOrg('org:update'), schema: { tags: ['invalid traffic'], params: orgIdParams, body: z.object({ text: z.string().trim().min(20).max(5000) }) } }, async (req) => {
    const user = requireUser(req);
    const { id } = paramsOf(req, orgIdParams);
    const { text } = req.body as { text: string };
    const r = await db.query(
      `UPDATE fraud_cases SET status = 'appealed', appeal_text = $3, appealed_at = now(), appealed_by = $4, updated_at = now()
       WHERE id = $1 AND status IN ('confirmed') AND ((subject_type = 'organization' AND subject_id = $2) OR (subject_type = 'site' AND subject_id IN (SELECT id FROM sites WHERE org_id = $2)) OR (subject_type = 'campaign' AND subject_id IN (SELECT id FROM campaigns WHERE org_id = $2)))
       RETURNING id`, [id, req.org!.id, text, user.id]);
    if (!r.rowCount) throw notFound('No appealable case found');
    await audit(db, req, { action: 'fraud_case.appeal', resourceType: 'fraud_case', resourceId: id, orgId: req.org!.id });
    await notifyStaff(app.ctx, ['super_admin', 'admin', 'ad_ops'], 'Invalid-traffic appeal submitted', `${req.org!.name} appealed a case.`, `/admin/fraud/${id}`).catch(() => undefined);
    return { ok: true };
  });
}
