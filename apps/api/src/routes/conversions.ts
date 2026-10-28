import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { toMicros } from '@blissnova/shared';
import { audit } from '../lib/audit';
import { notFound } from '../lib/errors';
import { bodyOf, orgIdParams, paramsOf } from '../lib/http';
import { requireOrg, requireUser } from '../plugins/auth';
import { recordConversion, type ConversionResult } from '../services/conversions';

const conversionFields = {
  click_id: z.uuid(),
  event: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{1,40}$/).default('conversion'),
  value: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  order_id: z.string().trim().max(100).optional(),
};
const pixelQuery = z.object(conversionFields);
// Documentation only: the pixel validates on its own so bad input still gets an image back.
const pixelDocs = z.object({ click_id: z.string().max(100).optional(), event: z.string().max(100).optional(), value: z.string().max(40).optional(), currency: z.string().max(10).optional(), order_id: z.string().max(200).optional() });
const postbackBody = z.object({ ...conversionFields, value: z.union([z.string().regex(/^\d{1,12}(\.\d{1,6})?$/), z.number().min(0).max(1e12)]).optional() });
const settingsBody = z.object({ enabled: z.boolean(), attributionWindowDays: z.number().int().min(1).max(90).optional() });

// 1x1 transparent GIF.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export async function conversionRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;
  const adv = { type: 'advertiser' as const };
  const mgmt = { rateLimit: { bucket: 'management' as const } };

  async function record(q: { click_id: string; event: string; value?: string | number; currency?: string; order_id?: string }, method: 'pixel' | 'postback'): Promise<ConversionResult> {
    return recordConversion(db, {
      clickId: q.click_id, event: q.event, valueMicros: q.value === undefined ? 0n : toMicros(typeof q.value === 'number' ? q.value.toFixed(6) : q.value),
      currency: q.currency, orderRef: q.order_id ?? '', method,
    });
  }

  function pixel(reply: FastifyReply) {
    return reply.type('image/gif').header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').send(PIXEL);
  }

  app.get('/conversions/pixel', { config: { rateLimit: { bucket: 'events' }, allowDuringMaintenance: true }, schema: { tags: ['conversions'], querystring: pixelDocs, description: 'Browser conversion pixel. Place on the page that confirms the conversion, passing the bn_click_id the landing page received. Always answers with a 1x1 image.' } }, async (req, reply) => {
    const parsed = pixelQuery.safeParse(req.query);
    if (parsed.success) await record(parsed.data, 'pixel').catch((err) => req.log.warn({ err }, 'conversion pixel failed'));
    return pixel(reply);
  });

  app.post('/conversions', { config: { rateLimit: { bucket: 'events' }, allowDuringMaintenance: true }, schema: { tags: ['conversions'], body: postbackBody, description: 'Server-to-server conversion postback. Answers with recorded, duplicate or rejected and the reason.' } }, async (req) => {
    const b = bodyOf(req, postbackBody);
    const r = await record(b, 'postback');
    return { data: r.status === 'recorded' ? { status: r.status, id: r.id } : r };
  });

  app.get('/orgs/:orgId/campaigns/:id/conversion-tracking', { preHandler: requireOrg('campaign:read', { ...adv, allowSuspended: true }), schema: { tags: ['conversions'], params: orgIdParams } }, async (req) => {
    const { id } = paramsOf(req, orgIdParams);
    const c = (await db.query(`SELECT id, conversion_tracking, attribution_window_days, currency FROM campaigns WHERE id = $1 AND org_id = $2`, [id, req.org!.id])).rows[0];
    if (!c) throw notFound();
    const stats = (await db.query(`SELECT count(*)::int AS conversions, COALESCE(sum(value_micros), 0)::text AS value, max(occurred_at) AS last_at FROM conversions WHERE campaign_id = $1`, [id])).rows[0];
    const byEvent = (await db.query(`SELECT event_name AS event, count(*)::int AS conversions, COALESCE(sum(value_micros), 0)::text AS "valueMicros" FROM conversions WHERE campaign_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [id])).rows;
    const base = `${ctx.config.PUBLIC_API_URL}/api/v1`;
    return { data: {
      enabled: c.conversion_tracking, attributionWindowDays: c.attribution_window_days, currency: c.currency,
      pixelUrl: `${base}/conversions/pixel?click_id={bn_click_id}&event=purchase&value={value}&currency=${c.currency}&order_id={order_id}`,
      postbackUrl: `${base}/conversions`,
      totals: { conversions: stats.conversions, valueMicros: stats.value, lastAt: stats.last_at, byEvent },
    } };
  });

  app.put('/orgs/:orgId/campaigns/:id/conversion-tracking', { config: mgmt, preHandler: requireOrg('campaign:write', adv), schema: { tags: ['conversions'], params: orgIdParams, body: settingsBody } }, async (req) => {
    requireUser(req);
    const { id } = paramsOf(req, orgIdParams);
    const b = bodyOf(req, settingsBody);
    const before = (await db.query(`SELECT conversion_tracking, attribution_window_days FROM campaigns WHERE id = $1 AND org_id = $2`, [id, req.org!.id])).rows[0];
    if (!before) throw notFound();
    const after = (await db.query(
      `UPDATE campaigns SET conversion_tracking = $3, attribution_window_days = COALESCE($4, attribution_window_days), updated_at = now() WHERE id = $1 AND org_id = $2
       RETURNING conversion_tracking, attribution_window_days`, [id, req.org!.id, b.enabled, b.attributionWindowDays ?? null])).rows[0];
    await audit(db, req, { action: 'campaign.conversion_tracking', resourceType: 'campaign', resourceId: id, orgId: req.org!.id, before, after });
    return { data: { enabled: after.conversion_tracking, attributionWindowDays: after.attribution_window_days } };
  });
}

