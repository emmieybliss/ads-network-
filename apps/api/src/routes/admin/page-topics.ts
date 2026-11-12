import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { classifyPage } from '@blissnova/ad-decision';
import { SAFETY_LEVELS, TOPIC_IDS } from '@blissnova/shared';
import { audit } from '../../lib/audit';
import { notFound } from '../../lib/errors';
import { bodyOf, queryOf } from '../../lib/http';
import { invalidatePageContext } from '../../services/page-context';
import { PAGE_SAFETY_SQL, PAGE_TOPIC_SQL } from '../../services/topics';
import { adminList, guard, meta, mgmt, sortSql, Where } from './common';

const listQuery = adminList.extend({
  safety: z.enum([...SAFETY_LEVELS, 'flagged']).optional(),
  topic: z.string().max(40).optional(),
  siteId: z.uuid().optional(),
  reviewed: z.enum(['yes', 'no']).optional(),
});
const pageRef = z.object({ siteId: z.uuid(), path: z.string().min(1).max(300) });
const overrideBody = pageRef.extend({
  /** null keeps the detected topics. */
  topics: z.array(z.enum(TOPIC_IDS)).max(3).nullable(),
  /** null keeps the detected risk. */
  safety: z.enum(SAFETY_LEVELS).nullable(),
  reason: z.string().trim().min(3, 'A reason is required').max(500),
});
const testBody = z.object({
  title: z.string().max(300).optional(),
  description: z.string().max(500).optional(),
  text: z.string().max(6000).optional(),
  path: z.string().max(300).optional(),
});

function serialize(r: Record<string, any>) {
  return {
    siteId: r.site_id, domain: r.domain, orgId: r.org_id, orgName: r.org_name, path: r.page_path, title: r.title, language: r.language,
    topics: r.topics, primaryTopic: r.primary_topic, brandSafety: r.brand_safety, safetyFlags: r.safety_flags, terms: r.terms, enoughText: r.enough_text,
    effectiveTopic: r.effective_topic || null, effectiveSafety: r.effective_safety,
    override: r.override_at ? { topics: r.override_topics, safety: r.override_safety, note: r.override_note, by: r.override_email, at: r.override_at } : null,
    classifierVersion: r.classifier_version, firstSeenAt: r.first_seen_at, classifiedAt: r.classified_at, pageviews30d: Number(r.views ?? 0),
  };
}

/**
 * Staff review of page topics and brand safety: the pages the classifier
 * flagged, corrections (which win over detection until cleared) and a tester
 * to see what the classifier makes of any text.
 */
export async function adminPageTopicRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const { db } = ctx;

  app.get('/admin/page-topics', { preHandler: guard('admin:orgs:read'), schema: { tags: ['admin: inventory'], querystring: listQuery, description: 'Classified pages, most at risk first by default, with page views in the last 30 days.' } }, async (req) => {
    const q = queryOf(req, listQuery);
    const w = new Where();
    if (q.safety === 'flagged') w.raw(`${PAGE_SAFETY_SQL} IN ('medium', 'high')`);
    else if (q.safety) w.add(`${PAGE_SAFETY_SQL} = ?`, q.safety);
    if (q.topic) w.add(`${PAGE_TOPIC_SQL} = ?`, q.topic === 'none' ? '' : q.topic);
    if (q.siteId) w.add('pc.site_id = ?', q.siteId);
    if (q.reviewed === 'yes') w.raw('pc.override_at IS NOT NULL');
    if (q.reviewed === 'no') w.raw('pc.override_at IS NULL');
    if (q.q) w.add('(s.domain ILIKE ? OR pc.page_path ILIKE ? OR pc.title ILIKE ?)', `%${q.q}%`);
    const from = `page_contexts pc JOIN sites s ON s.id = pc.site_id JOIN organizations o ON o.id = s.org_id ${w.sql}`;
    const total = Number((await db.query(`SELECT count(*)::int AS n FROM ${from}`, w.params)).rows[0].n);
    const risk = `CASE ${PAGE_SAFETY_SQL} WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END`;
    const rows = (await db.query(
      `SELECT pc.*, s.domain, s.org_id, o.name AS org_name, ${PAGE_TOPIC_SQL} AS effective_topic, ${PAGE_SAFETY_SQL} AS effective_safety, u.email AS override_email,
              (SELECT sum(v.views) FROM page_views v WHERE v.site_id = pc.site_id AND v.page_path = pc.page_path AND v.day > CURRENT_DATE - 30) AS views
       FROM ${from.replace(w.sql, '')} LEFT JOIN users u ON u.id = pc.override_by ${w.sql}
       ${sortSql(q, { risk: `${risk} DESC, pc.classified_at`, classified: 'pc.classified_at', path: 'pc.page_path', views: 'views' }, 'risk')}`, w.params)).rows;
    const summary = (await db.query(`SELECT ${PAGE_SAFETY_SQL} AS level, count(*)::int AS n FROM page_contexts pc GROUP BY 1`)).rows;
    return { data: rows.map(serialize), meta: meta(q, total), summary: Object.fromEntries(summary.map((r) => [r.level, r.n])) };
  });

  app.put('/admin/page-topics/override', { config: mgmt, preHandler: guard('admin:inventory:manage'), schema: { tags: ['admin: inventory'], body: overrideBody, description: 'Correct a page\'s topics and/or brand-safety risk. Pass null for both to go back to detection.' } }, async (req) => {
    const b = bodyOf(req, overrideBody);
    const before = (await db.query('SELECT pc.*, s.org_id FROM page_contexts pc JOIN sites s ON s.id = pc.site_id WHERE pc.site_id = $1 AND pc.page_path = $2', [b.siteId, b.path])).rows[0];
    if (!before) throw notFound('That page has not been classified yet');
    const clear = b.topics === null && b.safety === null;
    const after = (await db.query(
      `UPDATE page_contexts SET override_topics = $3, override_safety = $4, override_note = $5, override_by = $6, override_at = $7
       WHERE site_id = $1 AND page_path = $2 RETURNING *`,
      [b.siteId, b.path, b.topics && b.topics.length ? b.topics : null, b.safety, clear ? null : b.reason, clear ? null : req.auth!.user!.id, clear ? null : new Date()])).rows[0];
    await audit(db, req, {
      action: clear ? 'page_topics.override_cleared' : 'page_topics.override', resourceType: 'site', resourceId: b.siteId, orgId: before.org_id,
      before: { path: b.path, topics: before.override_topics, safety: before.override_safety }, after: { path: b.path, topics: after.override_topics, safety: after.override_safety }, reason: b.reason,
    });
    await invalidatePageContext(ctx, b.siteId, b.path);
    return { data: { siteId: b.siteId, path: b.path, override: after.override_at ? { topics: after.override_topics, safety: after.override_safety, note: after.override_note } : null } };
  });

  app.post('/admin/page-topics/recheck', { config: mgmt, preHandler: guard('admin:inventory:manage'), schema: { tags: ['admin: inventory'], body: pageRef, description: 'Classify the page again on its next ad request, whatever the reclassify interval.' } }, async (req) => {
    const b = bodyOf(req, pageRef);
    const r = await db.query(`UPDATE page_contexts SET content_hash = '', classified_at = to_timestamp(0) WHERE site_id = $1 AND page_path = $2`, [b.siteId, b.path]);
    if (!r.rowCount) throw notFound('That page has not been classified yet');
    await invalidatePageContext(ctx, b.siteId, b.path);
    return { data: { ok: true } };
  });

  app.post('/admin/page-topics/test', { config: mgmt, preHandler: guard('admin:orgs:read'), schema: { tags: ['admin: inventory'], body: testBody, description: 'Classify any text without storing anything: what topics and risk would a page with this text get?' } }, async (req) => {
    const b = bodyOf(req, testBody);
    const c = classifyPage({ title: b.title, description: b.description, text: b.text, path: b.path });
    return { data: { topics: c.topics, primary: c.primary, safety: c.safety, flags: c.flags, terms: c.terms, enoughText: c.enoughText, version: c.version } };
  });
}
