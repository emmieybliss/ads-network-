import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { balance } from '@blissnova/billing';
import { METRIC_DEFINITIONS, formatMicros } from '@blissnova/shared';
import { badRequest } from '../lib/errors';
import { dateRange, orgParams, queryOf, resolveRange, toCsv } from '../lib/http';
import { requireOrg } from '../plugins/auth';
import { requestStats, runReport, type GroupBy } from '../services/reports';

const reportQuery = dateRange.extend({
  groupBy: z.enum(['day', 'campaign', 'creative', 'site', 'unit', 'device', 'country']).default('day'),
  campaignId: z.uuid().optional(),
  siteId: z.uuid().optional(),
  unitId: z.uuid().optional(),
});

const ADV_GROUPS: GroupBy[] = ['day', 'campaign', 'creative', 'site', 'unit', 'device', 'country'];
const PUB_GROUPS: GroupBy[] = ['day', 'site', 'unit', 'device', 'country'];

export async function reportRoutes(app: FastifyInstance) {
  const { db } = app.ctx;

  function scopeFor(type: string, orgId: string, groupBy: GroupBy) {
    const allowed = type === 'advertiser' ? ADV_GROUPS : PUB_GROUPS;
    if (!allowed.includes(groupBy)) throw badRequest(`Grouping by ${groupBy} is not available for ${type} reports`);
    return type === 'advertiser' ? { advertiserOrgId: orgId } : { publisherOrgId: orgId };
  }

  app.get('/orgs/:orgId/reports', { preHandler: requireOrg('report:read', { allowSuspended: true }), schema: { tags: ['reports'], params: orgParams, querystring: reportQuery, description: 'Aggregated performance from validated events. CTR = valid clicks / valid impressions x 100.' } }, async (req) => {
    const q = queryOf(req, reportQuery);
    const range = resolveRange(q);
    const audience = req.org!.type;
    const report = await runReport(db, scopeFor(audience, req.org!.id, q.groupBy), { ...range, campaignId: q.campaignId, siteId: q.siteId, unitId: q.unitId }, q.groupBy, audience);
    const extra = audience === 'publisher' ? { requests: await requestStats(db, req.org!.id, { ...range, siteId: q.siteId }) } : {};
    return { data: { ...report, ...extra, range, groupBy: q.groupBy, currency: req.org!.currency, definitions: METRIC_DEFINITIONS } };
  });

  app.get('/orgs/:orgId/reports/export', { preHandler: requireOrg('report:read', { allowSuspended: true }), schema: { tags: ['reports'], params: orgParams, querystring: reportQuery } }, async (req, reply) => {
    const q = queryOf(req, reportQuery);
    const range = resolveRange(q);
    const audience = req.org!.type;
    const report = await runReport(db, scopeFor(audience, req.org!.id, q.groupBy), { ...range, campaignId: q.campaignId, siteId: q.siteId, unitId: q.unitId }, q.groupBy, audience, 10_000);
    const money = (v: unknown) => (v === null || v === undefined ? '' : formatMicros(String(v), 4));
    const rows = report.rows.map((r: Record<string, unknown>) => ({ ...r, ctr: r.ctr === null ? '' : (r.ctr as number).toFixed(4), spend: money(r.spendMicros), ecpm: money(r.ecpmMicros), earnings: money(r.earningsMicros), rpm: money(r.rpmMicros) }));
    const cols = [
      { key: 'label', label: q.groupBy }, { key: 'served', label: 'Served' }, { key: 'rendered', label: 'Rendered' }, { key: 'validImpressions', label: 'Valid impressions' },
      { key: 'invalidImpressions', label: 'Invalid impressions' }, { key: 'viewableImpressions', label: 'Viewable impressions' }, { key: 'validClicks', label: 'Valid clicks' },
      { key: 'invalidClicks', label: 'Invalid clicks' }, { key: 'ctr', label: 'CTR %' },
      ...(audience === 'advertiser' ? [{ key: 'spend', label: `Spend (${req.org!.currency})` }, { key: 'ecpm', label: 'eCPM' }] : [{ key: 'earnings', label: `Estimated earnings (${req.org!.currency})` }, { key: 'rpm', label: 'RPM' }]),
    ];
    await db.query('INSERT INTO data_exports (kind, requested_by, org_id, params, row_count) VALUES ($1, $2, $3, $4, $5)', [`report:${q.groupBy}`, req.auth?.user?.id ?? null, req.org!.id, JSON.stringify(q), rows.length]).catch(() => undefined);
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="report-${q.groupBy}-${range.from}-${range.to}.csv"`).send(toCsv(rows, cols));
  });

  app.get('/orgs/:orgId/dashboard', { preHandler: requireOrg('report:read', { allowSuspended: true }), schema: { tags: ['reports'], params: orgParams, querystring: dateRange } }, async (req) => {
    const range = resolveRange(queryOf(req, dateRange));
    const org = req.org!;
    if (org.type === 'advertiser') {
      const scope = { advertiserOrgId: org.id };
      const [trend, bySite, byUnit, byDevice, byCountry] = await Promise.all([
        runReport(db, scope, range, 'day', 'advertiser'), runReport(db, scope, range, 'site', 'advertiser', 10), runReport(db, scope, range, 'unit', 'advertiser', 10),
        runReport(db, scope, range, 'device', 'advertiser', 10), runReport(db, scope, range, 'country', 'advertiser', 10),
      ]);
      const camps = (await db.query(`SELECT status, count(*)::int AS n, COALESCE(sum(lifetime_budget_micros - spent_micros) FILTER (WHERE status IN ('active', 'scheduled', 'paused', 'pending_approval')), 0)::text AS remaining FROM campaigns WHERE org_id = $1 GROUP BY status`, [org.id])).rows;
      const wallet = await balance(db as never, { kind: 'advertiser_wallet', orgId: org.id }, org.currency);
      return { data: { type: 'advertiser', range, currency: org.currency, totals: trend.totals, trend: trend.rows, bySite: bySite.rows, byUnit: byUnit.rows, byDevice: byDevice.rows, byCountry: byCountry.rows,
        campaigns: Object.fromEntries(camps.map((c) => [c.status, c.n])), remainingBudgetMicros: camps.reduce((a, c) => a + BigInt(c.remaining), 0n).toString(), walletMicros: wallet.toString() } };
    }
    const scope = { publisherOrgId: org.id };
    const [trend, bySite, byUnit, byDevice] = await Promise.all([
      runReport(db, scope, range, 'day', 'publisher'), runReport(db, scope, range, 'site', 'publisher', 10), runReport(db, scope, range, 'unit', 'publisher', 10), runReport(db, scope, range, 'device', 'publisher', 10),
    ]);
    const sites = (await db.query(`SELECT status, count(*)::int AS n FROM sites WHERE org_id = $1 GROUP BY status`, [org.id])).rows;
    const [pending, available] = await Promise.all([balance(db as never, { kind: 'publisher_pending', orgId: org.id }, org.currency), balance(db as never, { kind: 'publisher_available', orgId: org.id }, org.currency)]);
    return { data: { type: 'publisher', range, currency: org.currency, totals: trend.totals, trend: trend.rows, bySite: bySite.rows, byUnit: byUnit.rows, byDevice: byDevice.rows,
      requests: await requestStats(db, org.id, range), sites: Object.fromEntries(sites.map((s) => [s.status, s.n])), pendingMicros: pending.toString(), availableMicros: available.toString() } };
  });
}
