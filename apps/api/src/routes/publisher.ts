import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { balance, requestPayout } from '@blissnova/billing';
import { toMicros } from '@blissnova/shared';
import { audit } from '../lib/audit';
import { AppError, badRequest, conflict, notFound } from '../lib/errors';
import { bodyOf, moneyString, orgIdParams, orgParams, paramsOf } from '../lib/http';
import { tx } from '../lib/tx';
import { requireOrg, requireUser } from '../plugins/auth';
import { checkVerification, isReservedHostname, newVerificationToken, normalizeDomain, txtRecordName, verificationInstructions, type VerificationMethod } from '../services/verification';
import { hit } from '../lib/ratelimit';
import { notifyStaff } from '../services/notifications';
import { invalidateServingCache } from '../services/serving';
import { adsTxtLine, checkAdsTxt, networkDomain } from '../services/adstxt';

const CATEGORIES = ['general', 'news', 'technology', 'business', 'finance', 'lifestyle', 'entertainment', 'sports', 'education', 'health', 'travel', 'food', 'automotive', 'gaming', 'parenting', 'real_estate', 'science', 'other'] as const;
const language = z.string().trim().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, 'Use a language code such as en or en-GB');
const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a two-letter country code such as US');
const siteBody = z.object({
  name: z.string().trim().min(1).max(160),
  domain: z.string().trim().min(3).max(253),
  category: z.enum(CATEGORIES).default('general'),
  description: z.string().trim().max(2000).optional(),
  language: language.optional(),
  country: country.optional(),
  allowedDomains: z.array(z.string().max(253)).max(20).default([]),
});
const sitePatch = siteBody.partial().omit({ domain: true });
const challengeBody = z.object({ method: z.enum(['dns_txt', 'html_file', 'meta_tag']) });
const submitBody = z.object({
  category: z.enum(CATEGORIES),
  description: z.string().trim().min(20, 'Describe the site in at least 20 characters').max(2000),
  language,
  country,
  reportedMonthlyPageviews: z.number().int().min(0).max(10_000_000_000).optional(),
  trafficSources: z.string().trim().max(1000).optional(),
  policyVersion: z.string().min(1).max(40),
  acceptPolicies: z.literal(true, { error: 'You must accept the publisher policies' }),
});
const unitBody = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/, 'Use lowercase letters, numbers, hyphens and underscores'),
  name: z.string().trim().min(1).max(120),
  formats: z.array(z.enum(['image', 'text', 'native'])).min(1).default(['image', 'text']),
  width: z.number().int().min(1).max(2000).nullable().optional(),
  height: z.number().int().min(1).max(2000).nullable().optional(),
  responsive: z.boolean().default(true),
  position: z.enum(['header', 'sidebar', 'in_content', 'footer', 'other']).default('in_content'),
});
const unitPatch = unitBody.partial().omit({ key: true });
const siteUnitParams = z.object({ orgId: z.uuid(), siteId: z.uuid() });
const payoutProfileBody = z.object({ method: z.enum(['bank_transfer', 'paypal', 'other']), displayLabel: z.string().trim().min(3).max(120) });
const payoutBody = z.object({ amount: moneyString });

export function siteKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return 'pk_' + Array.from(randomBytes(24), (b) => alphabet[b % alphabet.length]).join('');
}

export function serializeSite(s: Record<string, any>) {
  return {
    id: s.id, name: s.name, domain: s.domain, allowedDomains: s.allowed_domains, category: s.category, status: s.status, statusReason: s.status_reason,
    siteKey: s.public_key, verifiedAt: s.verified_at, verificationMethod: s.verification_method, verificationScope: s.verification_scope, verificationSimulated: s.verification_simulated,
    description: s.description, language: s.language, country: s.country, reportedMonthlyPageviews: s.reported_monthly_pageviews, trafficSources: s.traffic_sources,
    submittedAt: s.submitted_at, approvedAt: s.approved_at, allowedFormats: s.allowed_formats, revenueShareBps: s.revenue_share_bps, createdAt: s.created_at,
    adsTxtStatus: s.ads_txt_status, adsTxtCheckedAt: s.ads_txt_checked_at, adsTxtDetail: s.ads_txt_detail,
  };
}

export function serializeUnit(u: Record<string, any>) {
  return { id: u.id, siteId: u.site_id, key: u.key, name: u.name, formats: u.formats, width: u.width, height: u.height, responsive: u.responsive, position: u.position, status: u.status, adminBlocked: u.admin_blocked, createdAt: u.created_at };
}

export async function publisherRoutes(app: FastifyInstance) {
  const { db, config } = app.ctx;
  const mgmt = { rateLimit: { bucket: 'management' as const } };
  const pub = { type: 'publisher' as const };

  /**
   * Extra hostnames that may show this site's ads. A subdomain is accepted
   * only once a DNS proof covers it; file and meta-tag proofs are host-only.
   * Reserved development names are accepted outside production.
   */
  function cleanAllowed(site: { domain: string; verification_scope: string | null }, list: string[]) {
    const out: string[] = [];
    for (const raw of list) {
      const d = normalizeDomain(raw);
      if (!d) throw badRequest(`Invalid hostname: ${raw}`);
      if (d === site.domain) continue;
      const devName = !config.isProd && isReservedHostname(d);
      if (!devName) {
        if (!d.endsWith(`.${site.domain}`)) throw badRequest(`${d} is not part of ${site.domain}. Register it as its own site.`);
        if (site.verification_scope !== 'zone') throw badRequest(`${d} is a subdomain of ${site.domain}. Verify ${site.domain} with a DNS TXT record (which covers subdomains), or register ${d} as its own site.`);
      }
      if (!out.includes(d)) out.push(d);
    }
    return out;
  }

  const simulatorEnabled = config.ENABLE_DEV_VERIFICATION_SIMULATOR && !config.isProd;

  async function siteDetail(id: string) {
    const s = (await db.query('SELECT * FROM sites WHERE id = $1', [id])).rows[0];
    const [challenge, history, reviews] = await Promise.all([
      db.query(`SELECT * FROM site_verifications WHERE site_id = $1 AND status IN ('pending', 'failed') ORDER BY created_at DESC LIMIT 1`, [id]),
      db.query(`SELECT method, outcome, detail, simulated, created_at FROM site_verification_attempts WHERE site_id = $1 ORDER BY created_at DESC LIMIT 20`, [id]),
      db.query(`SELECT action, to_status, reason, created_at FROM site_reviews WHERE site_id = $1 ORDER BY created_at DESC LIMIT 10`, [id]),
    ]);
    const settings = await app.ctx.settings.get();
    const orgShare = (await db.query('SELECT revenue_share_bps FROM organizations WHERE id = $1', [s.org_id])).rows[0]?.revenue_share_bps;
    const v = challenge.rows[0];
    return {
      ...serializeSite(s),
      effectiveRevenueShareBps: s.revenue_share_bps ?? orgShare ?? settings.publishers.defaultRevenueShareBps,
      verification: {
        verified: Boolean(s.verified_at),
        method: s.verification_method,
        scope: s.verification_scope,
        simulated: s.verification_simulated,
        verifiedAt: s.verified_at,
        allowedMethods: settings.verification.allowedMethods,
        simulatorAvailable: simulatorEnabled && isReservedHostname(s.domain),
        challenge: v ? {
          id: v.id, method: v.method, hostname: v.hostname, status: v.status, attempts: v.attempts, expiresAt: v.expires_at,
          expired: new Date(v.expires_at).getTime() <= Date.now(), lastCheckedAt: v.last_checked_at, lastError: v.last_error,
          instructions: verificationInstructions(v.hostname, v.token)[v.method as VerificationMethod],
        } : null,
        history: history.rows.map((h) => ({ method: h.method, outcome: h.outcome, detail: h.detail, simulated: h.simulated, at: h.created_at })),
      },
      submission: {
        policyVersion: settings.publishers.policyVersion,
        policyAcceptedAt: s.policy_accepted_at, acceptedPolicyVersion: s.policy_version, submittedAt: s.submitted_at,
        canSubmit: Boolean(s.verified_at) && ['verified', 'rejected'].includes(s.status),
      },
      reviews: reviews.rows.map((r) => ({ action: r.action, status: r.to_status, reason: r.reason, at: r.created_at })),
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
    if (!domain) throw badRequest('Enter a valid hostname such as example.com');
    if (config.isProd && isReservedHostname(domain)) throw badRequest(`${domain} is a reserved name that cannot exist on the public internet`);
    const allowed = cleanAllowed({ domain, verification_scope: null }, b.allowedDomains);
    const id = await tx(app.ctx, async (c) => {
      const dup = await c.query(`SELECT org_id FROM sites WHERE domain = $1 AND status <> 'rejected'`, [domain]);
      if (dup.rowCount) throw conflict('This hostname is already registered on the network. Contact support if you own it.');
      const s = (await c.query(
        `INSERT INTO sites (org_id, name, domain, allowed_domains, category, description, language, country, public_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [req.org!.id, b.name, domain, allowed, b.category, b.description ?? null, b.language ?? null, b.country ?? null, siteKey()])).rows[0];
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
    const allowed = b.allowedDomains ? cleanAllowed(s, b.allowedDomains) : s.allowed_domains;
    const after = (await db.query(
      `UPDATE sites SET name = COALESCE($2, name), category = COALESCE($3, category), allowed_domains = $4, description = COALESCE($5, description),
         language = COALESCE($6, language), country = COALESCE($7, country), updated_at = now() WHERE id = $1 RETURNING *`,
      [s.id, b.name ?? null, b.category ?? null, allowed, b.description ?? null, b.language ?? null, b.country ?? null])).rows[0];
    await audit(db, req, { action: 'site.update', resourceType: 'site', resourceId: s.id, orgId: req.org!.id, before: serializeSite(s), after: serializeSite(after) });
    invalidateServingCache(app.ctx);
    return { data: await siteDetail(s.id) };
  });

  // ---------------------------------------------------------------- domain verification
  const VERIFIABLE = ['draft', 'verification_pending', 'rejected'];

  async function recordAttempt(c: { query: typeof db.query }, a: { challengeId: string | null; siteId: string; hostname: string; method: string; outcome: string; detail: string; evidence?: object; simulated?: boolean; actor: string | null }) {
    await c.query(
      `INSERT INTO site_verification_attempts (challenge_id, site_id, hostname, method, outcome, detail, evidence, simulated, actor_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [a.challengeId, a.siteId, a.hostname, a.method, a.outcome, a.detail.slice(0, 500), JSON.stringify(a.evidence ?? {}), a.simulated ?? false, a.actor]);
  }

  /** Marks the site verified inside a transaction. Shared by real checks and the simulator. */
  async function markSiteVerified(c: PoolClient, s: Record<string, any>, v: Record<string, any>, method: string, scope: 'host' | 'zone', simulated: boolean) {
    await c.query(`UPDATE site_verifications SET status = 'verified', verified_at = now(), consumed_at = now(), last_checked_at = now(), last_error = NULL, attempts = attempts + 1 WHERE id = $1`, [v.id]);
    await c.query(
      `UPDATE sites SET verified_at = now(), verification_method = $2, verification_scope = $3, verification_simulated = $4,
         status = CASE WHEN status IN ('draft', 'verification_pending') THEN 'verified' ELSE status END, updated_at = now() WHERE id = $1`,
      [s.id, method, scope, simulated]);
  }

  app.post('/orgs/:orgId/sites/:id/verification/challenge', { config: mgmt, preHandler: requireOrg('site:write', pub), schema: { tags: ['domain verification'], params: orgIdParams, body: challengeBody, description: 'Issue a new verification challenge (a fresh high-entropy token) for one method. Any earlier open challenge for the site is superseded.' } }, async (req, reply) => {
    const user = requireUser(req);
    const s = await ownSite(req.org!.id, paramsOf(req, orgIdParams).id);
    const { method } = bodyOf(req, challengeBody);
    const settings = await app.ctx.settings.get();
    if (!settings.verification.allowedMethods.includes(method)) throw badRequest('That verification method is turned off on this network');
    if (s.verified_at) throw conflict('This site is already verified');
    if (!VERIFIABLE.includes(s.status)) throw conflict(`A ${s.status.replace('_', ' ')} site cannot be verified`);
    await tx(app.ctx, async (c) => {
      await c.query(`UPDATE site_verifications SET status = 'superseded' WHERE site_id = $1 AND status IN ('pending', 'failed')`, [s.id]);
      const token = newVerificationToken();
      await c.query(
        `INSERT INTO site_verifications (site_id, method, token, hostname, record_name, expires_at, created_by) VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6), $7)`,
        [s.id, method, token, s.domain, method === 'dns_txt' ? txtRecordName(s.domain) : null, settings.verification.challengeTtlHours, user.id]);
      await c.query(`UPDATE sites SET status = 'verification_pending', updated_at = now() WHERE id = $1 AND status = 'draft'`, [s.id]);
      await audit(c, req, { action: 'site.verification_challenge', resourceType: 'site', resourceId: s.id, orgId: req.org!.id, after: { method } });
    });
    return reply.status(201).send({ data: await siteDetail(s.id) });
  });

  app.post('/orgs/:orgId/sites/:id/verification/check', { config: { rateLimit: { bucket: 'management', limit: 20 } }, preHandler: requireOrg('site:write', pub), schema: { tags: ['domain verification'], params: orgIdParams, description: 'Check the open challenge now. Safe to retry while DNS propagates.' } }, async (req) => {
    const user = requireUser(req);
    const s = await ownSite(req.org!.id, paramsOf(req, orgIdParams).id);
    if (s.verified_at) return { data: await siteDetail(s.id), verified: true };
    const v = (await db.query(`SELECT * FROM site_verifications WHERE site_id = $1 AND status IN ('pending', 'failed') ORDER BY created_at DESC LIMIT 1`, [s.id])).rows[0];
    if (!v) throw conflict('Choose a verification method first');
    if (v.hostname !== s.domain) throw conflict('This challenge was issued for a different hostname; start a new one');
    if (new Date(v.expires_at).getTime() <= Date.now()) {
      await db.query(`UPDATE site_verifications SET status = 'expired' WHERE id = $1`, [v.id]);
      await recordAttempt(db, { challengeId: v.id, siteId: s.id, hostname: s.domain, method: v.method, outcome: 'expired', detail: 'Challenge expired before it was completed', actor: user.id });
      return { data: await siteDetail(s.id), verified: false, outcome: 'expired', error: 'This challenge has expired. Start a new one to get a fresh token.' };
    }
    const settings = await app.ctx.settings.get();
    const rl = await hit(app.ctx.redis, `verify:host:${s.domain}`, settings.verification.maxChecksPerHostPerHour, 3600);
    if (!rl.allowed) {
      await recordAttempt(db, { challengeId: v.id, siteId: s.id, hostname: s.domain, method: v.method, outcome: 'blocked', detail: 'Too many checks for this hostname', actor: user.id });
      throw new AppError(429, 'rate_limited', `Too many verification checks for ${s.domain}. Try again in ${Math.ceil(rl.retryAfterSec / 60)} minutes.`);
    }

    const result = await checkVerification(v.method, s.domain, v.token, config, app.ctx.verifier);
    if (!result.ok) {
      await db.query(`UPDATE site_verifications SET status = 'failed', attempts = attempts + 1, last_checked_at = now(), last_error = $2 WHERE id = $1`, [v.id, result.detail]);
      await recordAttempt(db, { challengeId: v.id, siteId: s.id, hostname: s.domain, method: v.method, outcome: result.outcome, detail: result.detail, evidence: result.evidence, actor: user.id });
      return { data: await siteDetail(s.id), verified: false, outcome: result.outcome, error: result.detail };
    }
    const scope: 'host' | 'zone' = v.method === 'dns_txt' && settings.verification.dnsProofCoversSubdomains ? 'zone' : 'host';
    await tx(app.ctx, async (c) => {
      // Re-read under lock: two concurrent checks must not both consume the challenge.
      const fresh = (await c.query(`SELECT status FROM site_verifications WHERE id = $1 FOR UPDATE`, [v.id])).rows[0];
      if (!fresh || !['pending', 'failed'].includes(fresh.status)) throw conflict('This challenge is no longer open');
      await markSiteVerified(c, s, v, v.method, scope, false);
      await recordAttempt(c, { challengeId: v.id, siteId: s.id, hostname: s.domain, method: v.method, outcome: 'success', detail: result.detail, evidence: result.evidence, actor: user.id });
      await audit(c, req, { action: 'site.verified', resourceType: 'site', resourceId: s.id, orgId: req.org!.id, after: { method: v.method, scope } });
    });
    invalidateServingCache(app.ctx);
    return { data: await siteDetail(s.id), verified: true, outcome: 'success' };
  });

  if (simulatorEnabled) {
    // Development only. Not registered at all in production (and startup refuses the flag there).
    app.post('/orgs/:orgId/sites/:id/verification/simulate', { config: mgmt, preHandler: requireOrg('site:write', pub), schema: { tags: ['domain verification'], params: orgIdParams, description: 'DEVELOPMENT ONLY. Simulates a successful verification for a reserved local hostname (localhost, *.localhost, *.test, *.example). Unavailable in production.' } }, async (req) => {
      const user = requireUser(req);
      const s = await ownSite(req.org!.id, paramsOf(req, orgIdParams).id);
      if (config.isProd) throw notFound();
      if (!isReservedHostname(s.domain)) throw badRequest(`Simulated verification only works for local development hostnames such as localhost or demo.test. ${s.domain} must be verified for real.`);
      if (s.verified_at) throw conflict('This site is already verified');
      if (!VERIFIABLE.includes(s.status)) throw conflict(`A ${s.status.replace('_', ' ')} site cannot be verified`);
      await tx(app.ctx, async (c) => {
        await c.query(`UPDATE site_verifications SET status = 'superseded' WHERE site_id = $1 AND status IN ('pending', 'failed')`, [s.id]);
        const v = (await c.query(
          `INSERT INTO site_verifications (site_id, method, token, hostname, expires_at, created_by, simulated) VALUES ($1, 'meta_tag', $2, $3, now() + interval '1 hour', $4, true) RETURNING *`,
          [s.id, newVerificationToken(), s.domain, user.id])).rows[0];
        await markSiteVerified(c, s, v, 'simulated', 'host', true);
        await recordAttempt(c, { challengeId: v.id, siteId: s.id, hostname: s.domain, method: 'simulated', outcome: 'success', detail: 'SIMULATED verification (local development only)', simulated: true, actor: user.id });
        await audit(c, req, { action: 'site.verified_simulated', resourceType: 'site', resourceId: s.id, orgId: req.org!.id, after: { method: 'simulated' } });
      });
      invalidateServingCache(app.ctx);
      return { data: await siteDetail(s.id), verified: true, simulated: true };
    });
  }

  // ---------------------------------------------------------------- submission for review
  app.post('/orgs/:orgId/sites/:id/submit', { config: mgmt, preHandler: requireOrg('site:write', pub), schema: { tags: ['publisher sites'], params: orgIdParams, body: submitBody, description: 'Submit a verified site for policy and eligibility review. Verification alone never approves a site.' } }, async (req) => {
    const user = requireUser(req);
    const s = await ownSite(req.org!.id, paramsOf(req, orgIdParams).id);
    const b = bodyOf(req, submitBody);
    if (!s.verified_at) throw conflict('Verify that you control this hostname before submitting it for review');
    if (!['verified', 'rejected'].includes(s.status)) throw conflict(`A ${s.status.replace('_', ' ')} site cannot be submitted`);
    const settings = await app.ctx.settings.get();
    if (b.policyVersion !== settings.publishers.policyVersion) throw conflict('The publisher policies have changed. Review the current version and accept it again.', { currentVersion: settings.publishers.policyVersion });
    const e = settings.eligibility;
    const problems: string[] = [];
    if (e.allowedCountries.length && !e.allowedCountries.includes(b.country)) problems.push(`Sites from ${b.country} are not accepted at this time`);
    if (e.allowedLanguages.length && !e.allowedLanguages.includes(b.language.split('-')[0]!)) problems.push(`Content in ${b.language} is not accepted at this time`);
    if (e.prohibitedCategories.includes(b.category)) problems.push(`The ${b.category} category is not accepted on this network`);
    if (problems.length) throw badRequest('This site does not meet the published eligibility rules', { problems });
    const after = await tx(app.ctx, async (c) => {
      const row = (await c.query(
        `UPDATE sites SET status = 'submitted', category = $2, description = $3, language = $4, country = $5, reported_monthly_pageviews = $6, traffic_sources = $7,
           policy_version = $8, policy_accepted_at = now(), policy_accepted_by = $9, submitted_at = now(), status_reason = NULL, updated_at = now()
         WHERE id = $1 AND status IN ('verified', 'rejected') RETURNING *`,
        [s.id, b.category, b.description, b.language, b.country, b.reportedMonthlyPageviews ?? null, b.trafficSources ?? null, b.policyVersion, user.id])).rows[0];
      if (!row) throw conflict('The site changed while you were submitting it; reload and try again');
      await c.query(`INSERT INTO site_reviews (site_id, reviewer_id, action, from_status, to_status) VALUES ($1, $2, 'submit', $3, 'submitted')`, [s.id, user.id, s.status]);
      await audit(c, req, { action: 'site.submit', resourceType: 'site', resourceId: s.id, orgId: req.org!.id, before: { status: s.status }, after: { status: 'submitted', policyVersion: b.policyVersion } });
      return row;
    });
    await notifyStaff(app.ctx, ['super_admin', 'admin', 'ad_ops'], 'Site submitted for review', `${after.domain} is ready for review.`, `/admin/sites/${s.id}`).catch(() => undefined);
    return { data: await siteDetail(s.id) };
  });

  // ---------------------------------------------------------------- ad tag
  app.get('/orgs/:orgId/sites/:id/tag', { preHandler: requireOrg('site:read', { ...pub, allowSuspended: true }), schema: { tags: ['publisher sites'], params: orgIdParams } }, async (req) => {
    const s = await ownSite(req.org!.id, paramsOf(req, orgIdParams).id);
    if (s.status !== 'approved') {
      return { data: { available: false, reason: 'The ad tag becomes available once the site is approved.', status: s.status } };
    }
    const units = (await db.query(`SELECT * FROM ad_units WHERE site_id = $1 AND status <> 'archived' ORDER BY created_at`, [s.id])).rows;
    // Built from PUBLIC_API_URL, which production startup refuses to leave on localhost.
    const sdkUrl = `${config.PUBLIC_API_URL}/sdk/ads.js`;
    const snippet = (key: string, u?: Record<string, any>) => {
      const size = u && u.width && u.height && !u.responsive ? ` style="width:${u.width}px;height:${u.height}px"` : '';
      return `<div id="bn-ad-slot-${key}" data-bn-slot="${key}"${size}></div>\n<script async src="${sdkUrl}" data-site-key="${s.public_key}" data-slot="${key}"></script>`;
    };
    return {
      data: {
        available: true,
        siteKey: s.public_key,
        sdkUrl,
        loader: `<script async src="${sdkUrl}" data-site-key="${s.public_key}"></script>`,
        units: units.map((u) => ({ key: u.key, name: u.name, status: u.status, snippet: snippet(u.key, u), container: `<div data-bn-slot="${u.key}"></div>` })),
        instructions: [
          'Paste a placement snippet where the ad should appear. Each snippet is self-contained.',
          'For several placements on one page, load the script once and add one <div data-bn-slot="..."> per placement.',
          'Any site that can include HTML can use the tag; no plugin is required.',
        ],
        consent: {
          personalizedAllowed: (await app.ctx.settings.get()).tracking.personalizedAllowed,
          tcfVendorRegistered: config.TCF_VENDOR_ID !== undefined,
          signals: ['IAB TCF v2.2 (__tcfapi)', 'IAB GPP (__gpp): US national and US Privacy sections', 'US Privacy API (__uspapi)', 'Global Privacy Control'],
        },
      },
    };
  });

  // ---------------------------------------------------------------- ads.txt
  const adsTxtView = (s: Record<string, any>) => {
    const domain = networkDomain(config);
    return {
      line: adsTxtLine(domain, s.org_id),
      networkDomain: domain,
      sellerId: s.org_id,
      adsTxtUrl: `https://${s.domain}/ads.txt`,
      sellersJsonUrl: `${config.PUBLIC_SITE_URL}/sellers.json`,
      status: s.ads_txt_status,
      checkedAt: s.ads_txt_checked_at,
      detail: s.ads_txt_detail,
    };
  };

  app.get('/orgs/:orgId/sites/:id/ads-txt', { preHandler: requireOrg('site:read', { ...pub, allowSuspended: true }), schema: { tags: ['publisher sites'], params: orgIdParams, description: 'The line this site should list in its ads.txt, and the result of the last check.' } }, async (req) => {
    const s = await ownSite(req.org!.id, paramsOf(req, orgIdParams).id);
    return { data: adsTxtView(s) };
  });

  app.post('/orgs/:orgId/sites/:id/ads-txt/check', { config: { rateLimit: { bucket: 'management', limit: 20 } }, preHandler: requireOrg('site:write', pub), schema: { tags: ['publisher sites'], params: orgIdParams, description: 'Fetch the site\'s /ads.txt now and look for the BlissNova line.' } }, async (req) => {
    const s = await ownSite(req.org!.id, paramsOf(req, orgIdParams).id);
    if (!s.verified_at) throw conflict('Verify the site before checking ads.txt');
    const rl = await hit(app.ctx.redis, `adstxt:host:${s.domain}`, 30, 3600);
    if (!rl.allowed) throw new AppError(429, 'rate_limited', `Too many ads.txt checks for ${s.domain}. Try again in ${Math.ceil(rl.retryAfterSec / 60)} minutes.`);
    const r = await checkAdsTxt(s.domain, networkDomain(config), s.org_id, config, app.ctx.verifier.fetch);
    const row = (await db.query(
      `UPDATE sites SET ads_txt_status = $2, ads_txt_detail = $3, ads_txt_checked_at = now() WHERE id = $1 RETURNING *`,
      [s.id, r.status, r.detail.slice(0, 500)])).rows[0];
    return { data: adsTxtView(row) };
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
    const terms = (await db.query('SELECT tier, earnings_mode, min_cpm_micros, min_cpc_micros, guarantee_monthly_cap_micros, premium_advertisers_only FROM organizations WHERE id = $1', [req.org!.id])).rows[0];
    const guarantees = (await db.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, impressions, clicks, earned_micros, required_micros, shortfall_micros, topup_micros, capped, hold_until, finalized_at FROM publisher_guarantees WHERE org_id = $1 ORDER BY day DESC LIMIT 60`, [req.org!.id])).rows;
    return {
      data: {
        currency: cur,
        premium: {
          tier: terms.tier, earningsMode: terms.earnings_mode, minCpmMicros: terms.min_cpm_micros, minCpcMicros: terms.min_cpc_micros,
          guaranteeMonthlyCapMicros: terms.guarantee_monthly_cap_micros, premiumAdvertisersOnly: terms.premium_advertisers_only,
        },
        guarantees: guarantees.map((g) => ({ day: g.day, impressions: Number(g.impressions), clicks: Number(g.clicks), earnedMicros: g.earned_micros, requiredMicros: g.required_micros, shortfallMicros: g.shortfall_micros, topupMicros: g.topup_micros, capped: g.capped, holdUntil: g.hold_until, finalizedAt: g.finalized_at })),
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
