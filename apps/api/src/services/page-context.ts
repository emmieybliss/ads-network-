import { createHash } from 'node:crypto';
import { CLASSIFIER_VERSION, classifyPage, signalsHash, type Classification, type PageSignals } from '@blissnova/ad-decision';
import { SITE_CATEGORY_TOPICS, type PageSafety, type PlatformSettings, type SafetyLevel } from '@blissnova/shared';
import type { AppContext } from '../lib/context';

/**
 * Page topics and brand safety at serve time.
 *
 * The result for each page lives in Postgres (page_contexts) and is cached in
 * Redis, so serving needs at most one database read per page per hour. When
 * the ad tag sends a page's text sample and the text changed since the last
 * classification (or the classifier did), the page is classified again inline
 * (a few milliseconds, no I/O) and the new result is written with the serve log.
 */
export interface PageContextInput { title?: string; description?: string; headings?: string[]; text?: string; lang?: string }

export interface EffectivePageContext {
  /** Topics used for targeting: a reviewer's, else detected, else assumed from the site category. */
  topics: string[];
  primary: string | null;
  safety: PageSafety;
  /** Dictionary terms found on the page, used as extra page keywords. */
  terms: string[];
  source: 'manual' | 'page' | 'site' | 'none';
}

/** A new classification to store (with the serve log). */
export interface PageContextWrite {
  siteId: string; path: string; title: string | null; lang: string | null;
  topics: Classification['topics']; primary: string | null; safety: SafetyLevel; flags: Classification['flags']; terms: string[];
  hash: string; version: number; enoughText: boolean;
}

interface Cached {
  h: string; v: number; at: number;
  t: string[]; p: string | null; s: SafetyLevel; k: string[];
  ot: string[] | null; os: SafetyLevel | null;
}

const CACHE_TTL_S = 3600;

export function pageContextKey(siteId: string, path: string) {
  return `pctx:${siteId}:${createHash('sha1').update(path).digest('base64url')}`;
}

/** Drop the cached result for a page, after a reviewer changed it. */
export async function invalidatePageContext(ctx: Pick<AppContext, 'redis'>, siteId: string, path: string) {
  await ctx.redis.del(pageContextKey(siteId, path));
}

async function loadCached(ctx: AppContext, siteId: string, path: string): Promise<Cached | null> {
  const key = pageContextKey(siteId, path);
  const raw = await ctx.redis.get(key);
  if (raw) {
    try {
      const v = JSON.parse(raw) as Cached | { none: 1 };
      return 'none' in v ? null : v;
    } catch {
      /* fall through to the database */
    }
  }
  const r = (await ctx.db.query(
    `SELECT topics, primary_topic, brand_safety, terms, content_hash, classifier_version, classified_at, override_topics, override_safety
     FROM page_contexts WHERE site_id = $1 AND page_path = $2`, [siteId, path])).rows[0];
  if (!r) {
    await ctx.redis.set(key, JSON.stringify({ none: 1 }), 'EX', 600);
    return null;
  }
  const c: Cached = {
    h: r.content_hash, v: r.classifier_version, at: new Date(r.classified_at).getTime(),
    t: (r.topics as Array<{ id: string }>).map((x) => x.id), p: r.primary_topic, s: r.brand_safety, k: r.terms ?? [],
    ot: r.override_topics, os: r.override_safety,
  };
  await ctx.redis.set(key, JSON.stringify(c), 'EX', CACHE_TTL_S);
  return c;
}

function hasText(i: PageContextInput | undefined): i is PageContextInput {
  return !!i && Boolean(i.title?.trim() || i.text?.trim() || i.description?.trim() || i.headings?.length);
}

export async function resolvePageContext(
  ctx: AppContext,
  site: { id: string; category: string },
  path: string,
  keywords: string[],
  input: PageContextInput | undefined,
  settings: PlatformSettings,
): Promise<{ context: EffectivePageContext; write?: PageContextWrite }> {
  const siteTopics = SITE_CATEGORY_TOPICS[site.category] ?? [];
  const fallback = (safety: PageSafety = 'unknown'): EffectivePageContext => ({ topics: [...siteTopics], primary: siteTopics[0] ?? null, safety, terms: [], source: siteTopics.length ? 'site' : 'none' });
  if (!settings.contextual.enabled) return { context: fallback() };

  let cached = await loadCached(ctx, site.id, path);
  let write: PageContextWrite | undefined;
  if (hasText(input)) {
    const signals: PageSignals = { ...input, keywords, path };
    const stale = !cached || cached.v !== CLASSIFIER_VERSION
      || (cached.h !== signalsHash(signals) && Date.now() - cached.at >= settings.contextual.reclassifyMinutes * 60_000);
    if (stale) {
      const c = classifyPage(signals);
      cached = { h: c.hash, v: c.version, at: Date.now(), t: c.topics.map((x) => x.id), p: c.primary, s: c.safety, k: c.terms, ot: cached?.ot ?? null, os: cached?.os ?? null };
      await ctx.redis.set(pageContextKey(site.id, path), JSON.stringify(cached), 'EX', CACHE_TTL_S);
      write = {
        siteId: site.id, path, title: input.title?.trim().slice(0, 300) || null, lang: input.lang?.trim().slice(0, 20) || null,
        topics: c.topics, primary: c.primary, safety: c.safety, flags: c.flags, terms: c.terms, hash: c.hash, version: c.version, enoughText: c.enoughText,
      };
    }
  }
  if (!cached) return { context: fallback(), write };
  return { context: effective(cached, siteTopics), write };
}

function effective(c: Cached, siteTopics: string[]): EffectivePageContext {
  const safety = c.os ?? c.s;
  if (c.ot) return { topics: c.ot, primary: c.ot[0] ?? null, safety, terms: c.k, source: 'manual' };
  if (c.t.length) return { topics: c.t, primary: c.p ?? c.t[0] ?? null, safety, terms: c.k, source: 'page' };
  return { topics: [...siteTopics], primary: siteTopics[0] ?? null, safety, terms: c.k, source: siteTopics.length ? 'site' : 'none' };
}

/** Store a classification. A reviewer's correction is kept; an unchanged page is left alone. */
export async function writePageContext(db: AppContext['db'], w: PageContextWrite) {
  await db.query(
    `INSERT INTO page_contexts (site_id, page_path, title, language, topics, primary_topic, brand_safety, safety_flags, terms, content_hash, classifier_version, enough_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (site_id, page_path) DO UPDATE SET title = EXCLUDED.title, language = EXCLUDED.language, topics = EXCLUDED.topics, primary_topic = EXCLUDED.primary_topic,
       brand_safety = EXCLUDED.brand_safety, safety_flags = EXCLUDED.safety_flags, terms = EXCLUDED.terms, content_hash = EXCLUDED.content_hash,
       classifier_version = EXCLUDED.classifier_version, enough_text = EXCLUDED.enough_text, classified_at = now()
     WHERE page_contexts.content_hash IS DISTINCT FROM EXCLUDED.content_hash OR page_contexts.classifier_version <> EXCLUDED.classifier_version`,
    [w.siteId, w.path, w.title, w.lang, JSON.stringify(w.topics), w.primary, w.safety, JSON.stringify(w.flags), w.terms, w.hash, w.version, w.enoughText]);
}
