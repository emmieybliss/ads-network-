import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_BRAND, METRIC_DEFINITIONS, publicSettings } from '@blissnova/shared';
import { bodyOf } from '../lib/http';

const abuseBody = z.object({
  reporterEmail: z.email().optional(),
  subjectType: z.enum(['user', 'organization', 'site', 'creative', 'campaign', 'other']),
  subjectRef: z.string().trim().max(500).optional(),
  body: z.string().trim().min(10).max(5000),
});

export async function publicRoutes(app: FastifyInstance) {
  const { db } = app.ctx;
  const cfg = { rateLimit: { bucket: 'public' as const }, allowDuringMaintenance: true };

  app.get('/public/config', { config: cfg, schema: { tags: ['public'] } }, async (_req, reply) => {
    const s = await app.ctx.settings.get();
    reply.header('cache-control', 'public, max-age=60');
    return { data: { ...publicSettings(s), brand: { ...DEFAULT_BRAND, productName: s.branding.productName, companyName: s.branding.companyName, supportEmail: s.branding.supportEmail, publicSiteUrl: app.ctx.config.PUBLIC_SITE_URL, apiUrl: app.ctx.config.PUBLIC_API_URL }, metricDefinitions: METRIC_DEFINITIONS } };
  });

  app.get('/public/content', { config: cfg, schema: { tags: ['public'], querystring: z.object({ kind: z.string().max(40).optional() }) } }, async (req, reply) => {
    const { kind } = req.query as { kind?: string };
    const rows = (await db.query(`SELECT kind, slug, title, body, url, sort_order, updated_at FROM content_items WHERE published AND ($1::text IS NULL OR kind = $1) ORDER BY kind, sort_order, title`, [kind ?? null])).rows;
    reply.header('cache-control', 'public, max-age=60');
    return { data: rows };
  });

  app.get('/public/pricing', { config: cfg, schema: { tags: ['public'] } }, async (_req, reply) => {
    const rows = (await db.query(`SELECT audience, name, summary, price_label, features, cta_label, highlighted FROM pricing_plans WHERE published ORDER BY audience, sort_order`)).rows;
    reply.header('cache-control', 'public, max-age=60');
    return { data: rows };
  });

  app.post('/public/abuse-reports', { config: { rateLimit: { bucket: 'public' as const, limit: 5 } }, schema: { tags: ['public'], body: abuseBody } }, async (req, reply) => {
    const b = bodyOf(req, abuseBody);
    await db.query('INSERT INTO abuse_reports (reporter_email, subject_type, subject_ref, body) VALUES ($1, $2, $3, $4)', [b.reporterEmail ?? null, b.subjectType, b.subjectRef ?? null, b.body]);
    return reply.status(202).send({ ok: true });
  });
}
