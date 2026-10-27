import type { FastifyReply, FastifyInstance, FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { verifyDeliveryToken } from '@blissnova/tracking';
import { bodyOf } from '../lib/http';
import { admitEvent, processAdmittedEvent, type AdmittedEvent } from '../services/events';
import { getSnapshot, serveAds, writeServeLog } from '../services/serving';

const serveBody = z.object({
  siteKey: z.string().regex(/^pk_[A-Za-z0-9]{16,40}$/),
  units: z.array(z.object({ slot: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/) })).min(1).max(10),
  page: z.object({ url: z.string().max(2048), keywords: z.array(z.string().max(60)).max(20).optional() }),
  consent: z.object({
    personalized: z.boolean().optional(),
    gdprApplies: z.boolean().optional(),
    tcString: z.string().max(4096).regex(/^[A-Za-z0-9_.-]*$/).optional(),
    gpp: z.string().max(8192).regex(/^[A-Za-z0-9_.~-]*$/).optional(),
    gppSections: z.array(z.number().int().min(-1).max(255)).max(40).optional(),
    usp: z.string().max(4).optional(),
    gpc: z.boolean().optional(),
  }).optional(),
  vid: z.string().max(64).optional(),
  pv: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});
const eventsBody = z.object({
  events: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), type: z.enum(['render', 'viewable']), t: z.string().min(20).max(4096) })).min(1).max(50),
});

// The built ad tag: SDK_PATH if set, a copy next to a bundled build, or the
// workspace's sdk/ad-tag/dist when run from source or from apps/api/dist.
const here = dirname(fileURLToPath(import.meta.url));
const SDK_PATH = process.env.SDK_PATH
  ?? [join(here, 'sdk', 'bn.js'), join(here, '..', '..', '..', 'sdk', 'ad-tag', 'dist', 'bn.js'), join(here, '..', '..', '..', '..', 'sdk', 'ad-tag', 'dist', 'bn.js')].find((p) => existsSync(p))
  ?? join(here, 'sdk', 'bn.js');

export async function serveRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const inline = ctx.config.EVENT_PROCESSING === 'inline';

  function country(req: FastifyRequest) {
    const h = ctx.config.GEO_COUNTRY_HEADER;
    const v = h ? req.headers[h.toLowerCase()] : undefined;
    return typeof v === 'string' && /^[A-Z]{2}$/i.test(v) && v.toUpperCase() !== 'XX' ? v.toUpperCase() : 'ZZ';
  }

  async function dispatch(ev: AdmittedEvent) {
    const s = await ctx.settings.get();
    if (inline || !ctx.queues.events) return processAdmittedEvent(ctx, ev, s, { inline: true });
    await ctx.queues.events.add(ev.type, ev, { jobId: `ev-${ev.clientEventId}` });
    return null;
  }

  app.post('/serve', { config: { rateLimit: { bucket: 'serve' }, allowDuringMaintenance: true }, schema: { tags: ['ad serving'], body: serveBody, description: 'Request ads for one or more placements on a page. Unauthenticated; keyed by the public site key and restricted to the site\'s registered domains.' } }, async (req, reply) => {
    const b = bodyOf(req, serveBody);
    const s = await ctx.settings.get();
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    const out = await serveAds(ctx, b, { ip: req.ip, ipHash: req.ipHash, ua: req.headers['user-agent'] ?? '', origin, country: country(req), requestId: req.id, secGpc: req.headers['sec-gpc'] === '1' }, s);
    if (out.log) {
      if (inline || !ctx.queues.serveLog) await writeServeLog(ctx.db, out.log);
      else await ctx.queues.serveLog.add('log', out.log);
    }
    reply.header('cache-control', 'no-store');
    return { status: out.status, ads: out.ads, privacy: out.privacy };
  });

  app.post('/events', { config: { rateLimit: { bucket: 'events' }, allowDuringMaintenance: true }, schema: { tags: ['ad serving'], body: eventsBody, description: 'Report rendered and viewable impressions. Accepts application/json or text/plain (sendBeacon).' } }, async (req, reply) => {
    const b = bodyOf(req, eventsBody);
    const s = await ctx.settings.get();
    const meta = { ipHash: req.ipHash, ua: req.headers['user-agent'] ?? '', origin: typeof req.headers.origin === 'string' ? req.headers.origin : null, referrer: typeof req.headers.referer === 'string' ? req.headers.referer : null };
    let accepted = 0;
    const results: unknown[] = [];
    for (const e of b.events) {
      const a = await admitEvent(ctx, { clientEventId: e.id, type: e.type, token: e.t }, meta, s);
      if (!a.accepted) continue;
      accepted++;
      const r = await dispatch(a.event);
      if (r && ctx.config.NODE_ENV === 'test') results.push(r);
    }
    reply.status(202).header('cache-control', 'no-store');
    return ctx.config.NODE_ENV === 'test' ? { accepted, results } : { accepted };
  });

  app.get('/click', { config: { rateLimit: { bucket: 'events' }, allowDuringMaintenance: true }, schema: { tags: ['ad serving'], querystring: z.object({ t: z.string().min(20).max(4096) }), description: 'Click-tracking redirect. Redirects only to the destination stored for the creative; the URL cannot be supplied by the caller.' } }, async (req, reply) => {
    const { t } = req.query as { t: string };
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    const v = verifyDeliveryToken(ctx.tokens, t, Date.now(), 24 * 3600 * 1000);
    const claims = v.ok ? v.claims : v.claims;
    if (!claims) return reply.status(400).type('text/html').send(`<!doctype html><meta charset="utf-8"><title>Link expired</title><p>This advertisement link is no longer valid.</p>`);
    const dest = (await ctx.db.query<{ url: string }>(
      `SELECT COALESCE(v.snapshot->>'destinationUrl', c.destination_url) AS url FROM creatives c LEFT JOIN creative_versions v ON v.creative_id = c.id AND v.version = c.approved_version WHERE c.id = $1`, [claims.cr])).rows[0];
    const s = await ctx.settings.get();
    const a = await admitEvent(ctx, { clientEventId: `clk-${claims.d}-${req.ipHash.slice(0, 10)}-${Math.floor(Date.now() / 1000)}`, type: 'click', token: t },
      { ipHash: req.ipHash, ua: req.headers['user-agent'] ?? '', origin: null, referrer: typeof req.headers.referer === 'string' ? req.headers.referer : null }, s);
    if (a.accepted) await dispatch(a.event).catch((err) => req.log.error({ err }, 'click processing failed'));
    if (!dest?.url) return reply.status(404).type('text/html').send(`<!doctype html><meta charset="utf-8"><title>Not found</title><p>This advertisement is no longer available.</p>`);
    return reply.redirect(dest.url, 302);
  });

  app.get('/public/sites/:siteKey/status', { config: { rateLimit: { bucket: 'public' } }, schema: { tags: ['ad serving'], params: z.object({ siteKey: z.string().regex(/^pk_[A-Za-z0-9]{16,40}$/) }) } }, async (req) => {
    const { siteKey } = req.params as { siteKey: string };
    const snap = await getSnapshot(ctx);
    const site = snap.sites.get(siteKey);
    if (!site) return { active: false, placements: [] };
    return { active: true, placements: [...snap.units.values()].filter((u) => u.siteId === site.id).map((u) => ({ slot: u.key, width: u.width, height: u.height, formats: u.formats })) };
  });
}

/** Static, cacheable public assets: the ad tag and creative images. Registered at the root (not /api/v1). */
export async function staticRoutes(app: FastifyInstance) {
  let sdk: Buffer | null = null;
  // /sdk/ads.js is the documented address; /sdk/v1/bn.js is kept for tags already pasted.
  app.get('/sdk/ads.js', { schema: { hide: true } }, async (_req, reply) => sendSdk(reply));
  app.get('/sdk/v1/bn.js', { schema: { hide: true } }, async (_req, reply) => sendSdk(reply));
  async function sendSdk(reply: FastifyReply) {
    sdk ??= await readFile(SDK_PATH).catch(() => null);
    if (!sdk) return reply.status(503).type('application/javascript').send('/* BlissNova ad tag not built. Run pnpm --filter @blissnova/ad-tag build */');
    return reply.type('application/javascript; charset=utf-8').header('cache-control', 'public, max-age=300, stale-while-revalidate=86400').header('x-content-type-options', 'nosniff').send(sdk);
  }
  // sellers.json (IAB Tech Lab 1.0): every approved publisher the network sells
  // for, keyed by the seller id publishers put in their ads.txt. Names and
  // domains are omitted for publishers who asked to be confidential.
  app.get('/sellers.json', { schema: { hide: true } }, async (_req, reply) => {
    const rows = (await app.ctx.db.query(
      `SELECT o.id, o.name, o.website, o.sellers_json_confidential,
              (SELECT s.domain FROM sites s WHERE s.org_id = o.id AND s.status = 'approved' ORDER BY s.approved_at LIMIT 1) AS site_domain
       FROM organizations o
       WHERE o.type = 'publisher' AND o.status = 'approved' AND EXISTS (SELECT 1 FROM sites s WHERE s.org_id = o.id AND s.status = 'approved')
       ORDER BY o.created_at`)).rows;
    const domainOf = (r: Record<string, any>) => {
      try { return r.website ? new URL(r.website).hostname : r.site_domain; } catch { return r.site_domain; }
    };
    return reply.header('cache-control', 'public, max-age=3600').send({
      version: '1.0',
      sellers: rows.map((r) => r.sellers_json_confidential
        ? { seller_id: r.id, seller_type: 'PUBLISHER', is_confidential: 1 }
        : { seller_id: r.id, seller_type: 'PUBLISHER', name: r.name, domain: domainOf(r) }),
    });
  });

  app.get('/assets/*', { schema: { hide: true } }, async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    let data: Buffer | null = null;
    try {
      data = await app.ctx.storage.get(key);
    } catch {
      data = null;
    }
    if (!data) return reply.status(404).send({ error: { code: 'not_found', message: 'Not found', requestId: req.id } });
    const ext = key.split('.').pop();
    const type = ext === 'png' ? 'image/png' : ext === 'jpg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : 'image/webp';
    return reply.type(type).header('cache-control', 'public, max-age=31536000, immutable').header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'").send(data);
  });
}
