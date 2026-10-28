import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { METRIC_DEFINITIONS } from '@blissnova/shared';
import { dateRange, orgParams, queryOf, resolveRange } from '../lib/http';
import { forbidden } from '../lib/errors';
import { requireOrg } from '../plugins/auth';
import { analyticsOverview, realtime } from '../services/analytics';
import { queueEmail } from '../services/notifications';
import { buildPerformanceReport, nextSendAt, type ReportFrequency } from '../services/report-emails';
import { guard } from './admin/common';

const orgQuery = dateRange.extend({ siteId: z.uuid().optional(), campaignId: z.uuid().optional(), unitId: z.uuid().optional() });
const adminQuery = orgQuery.extend({ publisherOrgId: z.uuid().optional(), advertiserOrgId: z.uuid().optional() });
const realtimeQuery = z.object({ siteId: z.uuid().optional(), campaignId: z.uuid().optional() });
const adminRealtimeQuery = realtimeQuery.extend({ publisherOrgId: z.uuid().optional(), advertiserOrgId: z.uuid().optional() });

const reportEmailBody = z.object({ frequency: z.enum(['off', 'daily', 'weekly', 'monthly']) });

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

  // Scheduled report emails, per signed-in user and organization.
  const mgmt = { rateLimit: { bucket: 'management' as const } };
  const sessionUser = (req: { auth: { user: { id: string; email: string; name: string } | null } | null }) => {
    const u = req.auth?.user;
    if (!u) throw forbidden('Report emails belong to a signed-in user, not an API key.');
    return u;
  };
  const describe = (frequency: string, lastPeriodEnd: string | null) => ({
    frequency, lastPeriodEnd, nextSendAt: frequency === 'off' ? null : nextSendAt(frequency as ReportFrequency, lastPeriodEnd),
  });

  app.get('/orgs/:orgId/report-email', { preHandler: requireOrg('report:read', { allowSuspended: true }), schema: { tags: ['analytics'], params: orgParams, description: 'Your scheduled performance report email for this organization: off, daily, weekly (Monday to Sunday) or monthly, all UTC.' } }, async (req) => {
    const u = sessionUser(req);
    const row = (await db.query(`SELECT frequency, to_char(last_period_end, 'YYYY-MM-DD') AS last FROM report_subscriptions WHERE user_id = $1 AND org_id = $2`, [u.id, req.org!.id])).rows[0];
    return { data: describe(row?.frequency ?? 'off', row?.last ?? null) };
  });

  app.put('/orgs/:orgId/report-email', { config: mgmt, preHandler: requireOrg('report:read', { allowSuspended: true }), schema: { tags: ['analytics'], params: orgParams, body: reportEmailBody } }, async (req) => {
    const u = sessionUser(req);
    const { frequency } = req.body as z.infer<typeof reportEmailBody>;
    if (frequency === 'off') {
      await db.query('DELETE FROM report_subscriptions WHERE user_id = $1 AND org_id = $2', [u.id, req.org!.id]);
      return { data: describe('off', null) };
    }
    // Changing the frequency starts over, so the next run sends the latest complete period.
    const row = (await db.query(
      `INSERT INTO report_subscriptions (user_id, org_id, frequency) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, org_id) DO UPDATE SET frequency = EXCLUDED.frequency, updated_at = now(),
         last_period_end = CASE WHEN report_subscriptions.frequency = EXCLUDED.frequency THEN report_subscriptions.last_period_end END
       RETURNING to_char(last_period_end, 'YYYY-MM-DD') AS last`, [u.id, req.org!.id, frequency])).rows[0];
    return { data: describe(frequency, row.last) };
  });

  app.post('/orgs/:orgId/report-email/test', { config: { rateLimit: { bucket: 'management' as const, limit: 5, windowSec: 600 } }, preHandler: requireOrg('report:read', { allowSuspended: true }), schema: { tags: ['analytics'], params: orgParams, description: 'Emails you the last seven complete days now, in the same format as the scheduled report.' } }, async (req) => {
    const u = sessionUser(req);
    const org = req.org!;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const period = { from, to: yesterday, label: `${from} to ${yesterday}` };
    const report = await buildPerformanceReport(db, { id: org.id, type: org.type as 'advertiser' | 'publisher', currency: org.currency, name: org.name }, period);
    await queueEmail(app.ctx, u.email, 'performance_report', { name: u.name, orgName: org.name, frequencyLabel: 'sample', period: period.label, report, link: `${app.ctx.config.PUBLIC_SITE_URL}/${org.type}/analytics`,
      why: 'You asked for this sample from the Analytics page. Turn on daily, weekly or monthly reports there to get one on a schedule.' });
    return { data: { sentTo: u.email, period } };
  });
}
