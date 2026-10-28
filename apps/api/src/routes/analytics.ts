import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { METRIC_DEFINITIONS } from '@blissnova/shared';
import { dateRange, orgParams, queryOf, resolveRange } from '../lib/http';
import { requireOrg } from '../plugins/auth';
import { analyticsOverview, realtime } from '../services/analytics';
import { guard } from './admin/common';

const orgQuery = dateRange.extend({ siteId: z.uuid().optional(), campaignId: z.uuid().optional(), unitId: z.uuid().optional() });
const adminQuery = orgQuery.extend({ publisherOrgId: z.uuid().optional(), advertiserOrgId: z.uuid().optional() });
const realtimeQuery = z.object({ siteId: z.uuid().optional(), campaignId: z.uuid().optional() });
const adminRealtimeQuery = realtimeQuery.extend({ publisherOrgId: z.uuid().optional(), advertiserOrgId: z.uuid().optional() });

const DESCRIPTION = 'Analytics for the period and the same-length period before it: trend, breakdowns by device, OS, browser, country, traffic source, placement type and ad format, the delivery funnel, a weekday x hour heatmap (UTC), invalid traffic by reason, placement viewability and time in view, sessions and session RPM (publishers), conversions, CPA, ROAS and reach (advertisers). All from validated events.';

export async function analyticsRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  app.get('/orgs/:orgId/analytics', { preHandler: requireOrg('report:read', { allowSuspended: true }), schema: { tags: ['analytics'], params: orgParams, querystring: orgQuery, description: DESCRIPTION } }, async (req) => {
    const q = queryOf(req, orgQuery);
    const range = resolveRange(q);
    const org = req.org!;
    const scope = org.type === 'advertiser' ? { advertiserOrgId: org.id } : { publisherOrgId: org.id };
    // Advertisers filter by campaign, publishers by site and placement.
    const filters = org.type === 'advertiser' ? { campaignId: q.campaignId, siteId: q.siteId } : { siteId: q.siteId, unitId: q.unitId };
    const data = await analyticsOverview(db, scope, { ...range, ...filters }, org.type);
    return { data: { ...data, audience: org.type, currency: org.currency, definitions: METRIC_DEFINITIONS } };
  });

  app.get('/orgs/:orgId/analytics/realtime', { preHandler: requireOrg('report:read', { allowSuspended: true }), schema: { tags: ['analytics'], params: orgParams, querystring: realtimeQuery, description: 'The last 30 minutes, minute by minute, from the event log.' } }, async (req, reply) => {
    const q = queryOf(req, realtimeQuery);
    const org = req.org!;
    const scope = org.type === 'advertiser' ? { advertiserOrgId: org.id } : { publisherOrgId: org.id };
    reply.header('cache-control', 'no-store');
    return { data: { ...(await realtime(db, scope, org.type, q)), currency: org.currency } };
  });

  app.get('/admin/analytics', { preHandler: guard('admin:overview'), schema: { tags: ['admin: overview'], querystring: adminQuery, description: DESCRIPTION } }, async (req) => {
    const q = queryOf(req, adminQuery);
    const range = resolveRange(q);
    const data = await analyticsOverview(db, { publisherOrgId: q.publisherOrgId, advertiserOrgId: q.advertiserOrgId }, { ...range, siteId: q.siteId, campaignId: q.campaignId, unitId: q.unitId }, 'admin');
    const currency = (await app.ctx.settings.get()).pricing.defaultCurrency;
    return { data: { ...data, audience: 'admin', currency, definitions: METRIC_DEFINITIONS } };
  });

  app.get('/admin/analytics/realtime', { preHandler: guard('admin:overview'), schema: { tags: ['admin: overview'], querystring: adminRealtimeQuery } }, async (req, reply) => {
    const q = queryOf(req, adminRealtimeQuery);
    reply.header('cache-control', 'no-store');
    const currency = (await app.ctx.settings.get()).pricing.defaultCurrency;
    return { data: { ...(await realtime(db, { publisherOrgId: q.publisherOrgId, advertiserOrgId: q.advertiserOrgId }, 'admin', q)), currency } };
  });
}
