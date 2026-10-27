import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound, unauthenticated } from '../lib/errors';
import { dateRange, queryOf, resolveRange } from '../lib/http';
import { runReport } from '../services/reports';
import { normalizeDomain, verificationInstructions } from '../services/verification';

/**
 * Server-to-server integration endpoints (for a publisher's own CMS or tooling). They authenticate with an
 * organization API key (Authorization: Bearer bnk_...), which the integration keeps
 * server-side; only the public site key ever reaches browsers.
 */
function requireKey(scope: string) {
  return async (req: FastifyRequest) => {
    const k = req.auth?.apiKey;
    if (!k) throw unauthenticated('A valid API key is required');
    if (!k.scopes.includes(scope)) throw notFound();
  };
}

const siteQuery = z.object({ domain: z.string().min(3).max(253) });

export async function integrationRoutes(app: FastifyInstance) {
  const { db } = app.ctx;
  const cfg = { rateLimit: { bucket: 'management' as const, limit: 120 } };

  async function siteFor(req: FastifyRequest, domainRaw: string) {
    const domain = normalizeDomain(domainRaw);
    if (!domain) throw notFound();
    const s = (await db.query(`SELECT * FROM sites WHERE org_id = $1 AND (domain = $2 OR $2 = ANY(allowed_domains)) AND status <> 'rejected' LIMIT 1`, [req.auth!.apiKey!.orgId, domain])).rows[0];
    if (!s) throw notFound('No site with this domain is registered to the API key\'s organization');
    return s;
  }

  app.get('/integrations/ping', { config: cfg, schema: { tags: ['integrations'], security: [{ apiKey: [] }] } }, async (req) => {
    const k = req.auth?.apiKey;
    if (!k) throw unauthenticated('A valid API key is required');
    const org = (await db.query('SELECT name, type, status FROM organizations WHERE id = $1', [k.orgId])).rows[0];
    return { data: { organization: org.name, type: org.type, status: org.status, scopes: k.scopes } };
  });

  app.get('/integrations/site', { config: cfg, preHandler: requireKey('site:read'), schema: { tags: ['integrations'], querystring: siteQuery, security: [{ apiKey: [] }] } }, async (req) => {
    const s = await siteFor(req, queryOf(req, siteQuery).domain);
    const v = (await db.query(`SELECT token, expires_at FROM site_verifications WHERE site_id = $1 AND status IN ('pending', 'failed') AND method = 'meta_tag' ORDER BY created_at DESC LIMIT 1`, [s.id])).rows[0];
    const units = (await db.query(`SELECT key, name, formats, width, height, responsive, position, status FROM ad_units WHERE site_id = $1 AND status <> 'archived' ORDER BY created_at`, [s.id])).rows;
    return {
      data: {
        siteKey: s.public_key, name: s.name, domain: s.domain, status: s.status, verified: Boolean(s.verified_at),
        verification: !s.verified_at && v ? { metaTag: verificationInstructions(s.domain, v.token).meta_tag.value, token: v.token, expiresAt: v.expires_at } : null,
        placements: units, sdkUrl: `${app.ctx.config.PUBLIC_API_URL}/sdk/v1/bn.js`, apiUrl: app.ctx.config.PUBLIC_API_URL,
      },
    };
  });

  app.get('/integrations/stats', { config: cfg, preHandler: requireKey('report:read'), schema: { tags: ['integrations'], querystring: siteQuery.merge(dateRange), security: [{ apiKey: [] }] } }, async (req) => {
    const q = queryOf(req, siteQuery.merge(dateRange));
    const s = await siteFor(req, q.domain);
    const range = resolveRange(q, 7);
    const r = await runReport(db, { publisherOrgId: req.auth!.apiKey!.orgId }, { ...range, siteId: s.id }, 'day', 'publisher');
    return { data: { range, totals: r.totals, days: r.rows } };
  });
}
