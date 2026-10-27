#!/usr/bin/env node
/**
 * Load test for the ad-serving path.
 *
 * It measures what it measures and nothing more: one process, plain fetch, no
 * connection tuning, against whatever API the URL points at. Numbers from a
 * laptop or a CI container are not a capacity plan for production hardware;
 * treat them as a regression signal and a sanity check on the shape of the
 * latency distribution.
 *
 * Usage:
 *   API_URL=http://localhost:4000 SITE_KEY=pk_... SLOT=sidebar_300x250 \
 *     [DURATION=15] [CONCURRENCY=40] [PAGE_URL=http://example.org/a] \
 *     node tests/load/serve.mjs
 *
 * Get SITE_KEY and SLOT from `pnpm db:seed`, which prints both.
 */

const API_URL = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const SITE_KEY = process.env.SITE_KEY ?? '';
const SLOT = process.env.SLOT ?? 'sidebar_300x250';
const PAGE_URL = process.env.PAGE_URL ?? 'http://example.org/article';
const DURATION = Number(process.env.DURATION ?? 15);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 40);
const REPORT_EVENTS = process.env.REPORT_EVENTS !== 'false';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

if (!/^pk_[A-Za-z0-9]{16,40}$/.test(SITE_KEY)) {
  console.error('SITE_KEY is required and must look like pk_... (run `pnpm db:seed` to get one).');
  process.exit(1);
}

const idChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function id(len = 16) {
  let s = '';
  for (let i = 0; i < len; i++) s += idChars[(Math.random() * idChars.length) | 0];
  return s;
}

const origin = (() => {
  try {
    return new URL(PAGE_URL).origin;
  } catch {
    return undefined;
  }
})();

const stats = {
  serve: { latencies: [], ok: 0, filled: 0, empty: 0, failed: 0, byStatus: new Map() },
  events: { latencies: [], ok: 0, failed: 0 },
};

function record(bucket, ms, ok) {
  bucket.latencies.push(ms);
  if (ok) bucket.ok++;
  else bucket.failed++;
}

async function oneCycle() {
  const started = performance.now();
  let served;
  try {
    const res = await fetch(`${API_URL}/api/v1/serve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA, ...(origin ? { origin } : {}) },
      body: JSON.stringify({
        siteKey: SITE_KEY,
        units: [{ slot: SLOT }],
        page: { url: PAGE_URL },
        pv: id(16),
      }),
    });
    const ms = performance.now() - started;
    stats.serve.byStatus.set(res.status, (stats.serve.byStatus.get(res.status) ?? 0) + 1);
    if (!res.ok) {
      record(stats.serve, ms, false);
      await res.arrayBuffer();
      return;
    }
    served = await res.json();
    record(stats.serve, ms, true);
  } catch {
    record(stats.serve, performance.now() - started, false);
    return;
  }

  const ad = served?.ads?.[0]?.ad ?? null;
  if (!ad) {
    stats.serve.empty++;
    return;
  }
  stats.serve.filled++;

  if (!REPORT_EVENTS) return;
  const t0 = performance.now();
  try {
    const res = await fetch(`${API_URL}/api/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA, referer: PAGE_URL, ...(origin ? { origin } : {}) },
      body: JSON.stringify({ events: [{ id: id(22), type: 'render', t: ad.token }] }),
    });
    await res.arrayBuffer();
    record(stats.events, performance.now() - t0, res.ok);
  } catch {
    record(stats.events, performance.now() - t0, false);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function summarise(name, bucket, seconds) {
  const sorted = [...bucket.latencies].sort((a, b) => a - b);
  const total = bucket.ok + bucket.failed;
  const f = (v) => (v === null ? '   n/a' : `${v.toFixed(1)} ms`);
  console.log(`\n${name}`);
  console.log(`  requests        ${total} (${bucket.failed} failed)`);
  console.log(`  throughput      ${(total / seconds).toFixed(1)} req/s`);
  console.log(`  mean            ${f(sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null)}`);
  console.log(`  p50             ${f(percentile(sorted, 50))}`);
  console.log(`  p95             ${f(percentile(sorted, 95))}`);
  console.log(`  p99             ${f(percentile(sorted, 99))}`);
  console.log(`  max             ${f(sorted.length ? sorted[sorted.length - 1] : null)}`);
}

async function main() {
  // One request first, so a misconfiguration fails immediately rather than
  // after the whole run.
  const probe = await fetch(`${API_URL}/health`).catch(() => null);
  if (!probe?.ok) {
    console.error(`No healthy API at ${API_URL}. Start it with \`pnpm dev:api\`.`);
    process.exit(1);
  }

  console.log(`Load test against ${API_URL}`);
  console.log(`  site key        ${SITE_KEY}`);
  console.log(`  slot            ${SLOT}`);
  console.log(`  page            ${PAGE_URL}`);
  console.log(`  concurrency     ${CONCURRENCY}`);
  console.log(`  duration        ${DURATION}s`);
  console.log(`  report renders  ${REPORT_EVENTS}`);
  console.log('\nRunning...');

  const deadline = Date.now() + DURATION * 1000;
  const startedAt = performance.now();
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (Date.now() < deadline) await oneCycle();
  });
  await Promise.all(workers);
  const seconds = (performance.now() - startedAt) / 1000;

  summarise('POST /api/v1/serve', stats.serve, seconds);
  console.log(`  filled          ${stats.serve.filled}`);
  console.log(`  no fill         ${stats.serve.empty}`);
  if (stats.serve.byStatus.size > 1 || !stats.serve.byStatus.has(200)) {
    console.log(`  status codes    ${[...stats.serve.byStatus].map(([k, v]) => `${k}:${v}`).join(' ')}`);
  }
  if (REPORT_EVENTS) summarise('POST /api/v1/events', stats.events, seconds);

  const noFillRate = stats.serve.filled + stats.serve.empty ? stats.serve.empty / (stats.serve.filled + stats.serve.empty) : 0;
  if (noFillRate > 0.5) {
    console.log(
      '\nMost requests returned no ad. That is usually a campaign with no budget left, a\n' +
        'frequency cap, a rate limit, or a page URL the site has not registered. The\n' +
        'latency figures above are then measuring the rejection path, not delivery.',
    );
  }
  if (stats.serve.failed > 0) {
    console.log(`\n${stats.serve.failed} request(s) failed outright. Investigate before trusting these numbers.`);
  }
  console.log(
    '\nThese figures describe this machine, this database and this dataset. They are not\n' +
      'a production capacity estimate, and nothing here has been measured on production\n' +
      'hardware.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
