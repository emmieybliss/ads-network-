/**
 * Automatic domain verification: the proofs themselves, the SSRF and redirect
 * defences around them, challenge expiry and replay, the review workflow that
 * follows, and the guarantee that the development simulator does not exist in
 * production.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@blissnova/api/config';
import {
  checkVerification,
  hostCovered,
  isReservedHostname,
  metaContents,
  normalizeDomain,
  safeFetch,
  txtRecordName,
  type SafeFetchOptions,
  type SafeFetchResult,
} from '@blissnova/api/services/verification';
import { PaymentProviderRegistry } from '@blissnova/api/services/payments/registry';
import { invalidateServingCache } from '@blissnova/api/services/serving';
import { createHarness, testConfig, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { makeOrg, makeSite, makeUser } from '../helpers/fixtures';

// ------------------------------------------------------------------ fakes

/** What the fake web and DNS return, set per test. */
const world = {
  txt: new Map<string, string[][]>(),
  pages: new Map<string, { status: number; body: string; contentType?: string }>(),
};
const fakeFetch = async (url: string, _opts: SafeFetchOptions): Promise<SafeFetchResult> => {
  const page = world.pages.get(url) ?? { status: 404, body: 'not found', contentType: 'text/plain' };
  return { status: page.status, body: page.body, contentType: page.contentType ?? 'text/html', finalUrl: url, redirects: [] };
};
const fakeResolver = {
  resolveTxt: async (name: string) => {
    const r = world.txt.get(name);
    if (!r) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return r;
  },
};

const cfg = { VERIFICATION_ALLOW_HTTP: false, VERIFICATION_PRIVATE_HOST_ALLOWLIST: '', VERIFICATION_DNS_SERVERS: '', isProd: false };

// ------------------------------------------------------------------ pure checks

describe('verification proofs', () => {
  beforeEach(() => {
    world.txt.clear();
    world.pages.clear();
  });

  it('accepts the exact TXT value at the _blissnova-verification name', async () => {
    world.txt.set(txtRecordName('pub.example.org'), [['blissnova-verification=bnv_abc']]);
    const r = await checkVerification('dns_txt', 'pub.example.org', 'bnv_abc', cfg, { resolver: fakeResolver });
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe('success');
  });

  it('joins TXT strings split across chunks', async () => {
    world.txt.set(txtRecordName('pub.example.org'), [['blissnova-verification=', 'bnv_abc']]);
    expect((await checkVerification('dns_txt', 'pub.example.org', 'bnv_abc', cfg, { resolver: fakeResolver })).ok).toBe(true);
  });

  it('reports a missing record as not found, so the publisher can retry later', async () => {
    const r = await checkVerification('dns_txt', 'pub.example.org', 'bnv_abc', cfg, { resolver: fakeResolver });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('not_found');
    expect(r.detail).toMatch(/propagat/);
  });

  it('refuses a stale or different token', async () => {
    world.txt.set(txtRecordName('pub.example.org'), [['blissnova-verification=bnv_old']]);
    const r = await checkVerification('dns_txt', 'pub.example.org', 'bnv_new', cfg, { resolver: fakeResolver });
    expect(r.outcome).toBe('mismatch');
  });

  it('does not accept the token at the apex instead of the verification name', async () => {
    world.txt.set('pub.example.org', [['blissnova-verification=bnv_abc']]);
    expect((await checkVerification('dns_txt', 'pub.example.org', 'bnv_abc', cfg, { resolver: fakeResolver })).ok).toBe(false);
  });

  it('accepts a verification file containing only the token', async () => {
    world.pages.set('https://pub.example.org/.well-known/blissnova-verification.txt', { status: 200, body: 'bnv_abc\n', contentType: 'text/plain' });
    expect((await checkVerification('html_file', 'pub.example.org', 'bnv_abc', cfg, { fetch: fakeFetch })).ok).toBe(true);
  });

  it('refuses a soft-404 HTML page that happens to contain the token', async () => {
    world.pages.set('https://pub.example.org/.well-known/blissnova-verification.txt', { status: 200, body: '<html><body>Not found: bnv_abc</body></html>' });
    const r = await checkVerification('html_file', 'pub.example.org', 'bnv_abc', cfg, { fetch: fakeFetch });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('mismatch');
  });

  it('refuses a file with extra content', async () => {
    world.pages.set('https://pub.example.org/.well-known/blissnova-verification.txt', { status: 200, body: 'bnv_abc bnv_other', contentType: 'text/plain' });
    expect((await checkVerification('html_file', 'pub.example.org', 'bnv_abc', cfg, { fetch: fakeFetch })).ok).toBe(false);
  });

  it('accepts the meta tag in the head, in either attribute order', async () => {
    world.pages.set('https://pub.example.org/', { status: 200, body: `<!doctype html><html><head><title>x</title><meta content="bnv_abc" name="blissnova-site-verification"></head><body></body></html>` });
    expect((await checkVerification('meta_tag', 'pub.example.org', 'bnv_abc', cfg, { fetch: fakeFetch })).ok).toBe(true);
  });

  it('ignores the token when it only appears in the body, a comment or a script', () => {
    const html = `<html><head>
      <!-- <meta name="blissnova-site-verification" content="bnv_c"> -->
      <script>var s = '<meta name="blissnova-site-verification" content="bnv_s">';</script>
      <meta name="description" content="bnv_d">
    </head><body><meta name="blissnova-site-verification" content="bnv_b"><p>bnv_b</p></body></html>`;
    expect(metaContents(html, 'blissnova-site-verification')).toEqual([]);
  });

  it('decodes entities and unquoted attributes like a browser would', () => {
    expect(metaContents(`<head><META NAME=blissnova-site-verification CONTENT=bnv_x></head>`, 'blissnova-site-verification')).toEqual(['bnv_x']);
    expect(metaContents(`<head><meta name='blissnova-site-verification' content='a&amp;b'></head>`, 'blissnova-site-verification')).toEqual(['a&b']);
  });
});

describe('hostnames', () => {
  it('normalises input and rejects things that are not hostnames', () => {
    expect(normalizeDomain('https://www.Example.ORG/path?x=1')).toBe('example.org');
    expect(normalizeDomain('blog.example.org.')).toBe('blog.example.org');
    expect(normalizeDomain('http://user:pass@example.org')).toBeNull();
    expect(normalizeDomain('127.0.0.1')).toBeNull();
    expect(normalizeDomain('[::1]')).toBeNull();
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('-bad-.example.org')).toBeNull();
  });

  it('knows which names can never be real public sites', () => {
    for (const h of ['localhost', 'demo.localhost', 'news.test', 'site.example', 'example.com', 'a.example.org', 'printer.local', 'x.internal']) expect(isReservedHostname(h), h).toBe(true);
    for (const h of ['blissnova-demo.com', 'example.co', 'myexample.com', 'test.io']) expect(isReservedHostname(h), h).toBe(false);
  });

  it('scopes a host proof to the host and a DNS proof to the zone', () => {
    expect(hostCovered('example.co', 'host', 'www.example.co')).toBe(true);
    expect(hostCovered('example.co', 'host', 'blog.example.co')).toBe(false);
    expect(hostCovered('example.co', 'zone', 'blog.example.co')).toBe(true);
    expect(hostCovered('example.co', 'zone', 'evilexample.co')).toBe(false);
  });
});

// ------------------------------------------------------------------ SSRF

describe('outbound request protection', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect-away') return res.writeHead(302, { location: 'http://attacker.test/' }).end();
      if (req.url === '/redirect-ip') return res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
      if (req.url === '/redirect-same') return res.writeHead(301, { location: '/final' }).end();
      if (req.url === '/loop') return res.writeHead(302, { location: '/loop' }).end();
      if (req.url === '/big') return res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(10_000));
      if (req.url === '/slow') return setTimeout(() => res.end('late'), 2000);
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const base = (o: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({ allowedHosts: ['localhost'], allowHttp: true, privateAllowlist: [], ...o });

  it('refuses a hostname that resolves to a loopback address', async () => {
    await expect(safeFetch(`http://localhost:${port}/`, base())).rejects.toThrow(/private or reserved/);
  });

  it('refuses IP-literal URLs, including the cloud metadata address', async () => {
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/', base({ allowedHosts: ['169.254.169.254'] }))).rejects.toThrow(/IP addresses/);
    await expect(safeFetch(`http://127.0.0.1:${port}/`, base({ allowedHosts: ['127.0.0.1'] }))).rejects.toThrow(/IP addresses/);
  });

  it('refuses plain HTTP and non-standard ports unless the development override is on', async () => {
    await expect(safeFetch('http://pub.example.org/', base({ allowedHosts: ['pub.example.org'], allowHttp: false }))).rejects.toThrow(/Only HTTPS/);
    await expect(safeFetch('https://pub.example.org:8443/', base({ allowedHosts: ['pub.example.org'], allowHttp: false }))).rejects.toThrow(/standard HTTPS port/);
  });

  it('refuses URLs carrying credentials', async () => {
    await expect(safeFetch('https://u:p@pub.example.org/', base({ allowedHosts: ['pub.example.org'] }))).rejects.toThrow(/credentials/);
  });

  // The remaining cases use a development allowlist so the local test server is reachable at all.
  const local = () => base({ privateAllowlist: ['localhost'] });

  it('follows a redirect that stays on the same host', async () => {
    const r = await safeFetch(`http://localhost:${port}/redirect-same`, local());
    expect(r.status).toBe(200);
    expect(r.redirects).toHaveLength(1);
  });

  it('refuses a redirect to an unrelated host', async () => {
    await expect(safeFetch(`http://localhost:${port}/redirect-away`, local())).rejects.toThrow(/attacker\.test/);
  });

  it('refuses a redirect to an internal address', async () => {
    await expect(safeFetch(`http://localhost:${port}/redirect-ip`, local())).rejects.toThrow();
  });

  it('stops after a bounded number of redirects', async () => {
    await expect(safeFetch(`http://localhost:${port}/loop`, local())).rejects.toThrow(/Too many redirects/);
  });

  it('caps the response size', async () => {
    await expect(safeFetch(`http://localhost:${port}/big`, { ...local(), maxBytes: 1000 })).rejects.toThrow(/larger than allowed/);
  });

  it('times out', async () => {
    await expect(safeFetch(`http://localhost:${port}/slow`, { ...local(), timeoutMs: 300 })).rejects.toThrow(/timed out/);
  });
});

// ------------------------------------------------------------------ workflow through the API

let h: Harness;
let prodH: Harness;

beforeAll(async () => {
  h = await createHarness({ ENABLE_DEV_VERIFICATION_SIMULATOR: 'true' }, { overrides: { verifier: { fetch: fakeFetch, resolver: fakeResolver } } });
  // A production-mode app built from an object that bypasses loadConfig's refusal,
  // to prove the simulator route is not registered even if the flag were set.
  prodH = await createHarness({}, { config: (c) => ({ ...c, NODE_ENV: 'production', isProd: true, ENABLE_DEV_VERIFICATION_SIMULATOR: true, ENABLE_DEV_PAYMENTS: true }) });
});
afterAll(async () => {
  await h?.close();
  await prodH?.close();
});
beforeEach(async () => {
  await h.reset();
  world.txt.clear();
  world.pages.clear();
});

async function publisher(harness = h) {
  const user = await makeUser(harness.db, { email: `pub-${Math.random().toString(36).slice(2)}@example.com` });
  const cl = new Client(harness.app);
  expect((await cl.post('/api/v1/auth/login', { email: user.email, password: user.password })).status).toBe(200);
  const org = await makeOrg(harness.db, { type: 'publisher', ownerId: user.id });
  return { user, cl, org };
}

async function admin() {
  const user = await makeUser(h.db, { email: `admin-${Math.random().toString(36).slice(2)}@example.com`, platformRole: 'super_admin' });
  const cl = new Client(h.app);
  expect((await cl.post('/api/v1/auth/login', { email: user.email, password: user.password })).status).toBe(200);
  return { user, cl };
}

async function addSite(p: { cl: Client; org: string }, domain: string) {
  const r = await p.cl.post(`/api/v1/orgs/${p.org}/sites`, { name: 'My site', domain, category: 'technology' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string; status: string };
}

async function challenge(p: { cl: Client; org: string }, siteId: string, method: string) {
  const r = await p.cl.post(`/api/v1/orgs/${p.org}/sites/${siteId}/verification/challenge`, { method });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.verification.challenge as { id: string; instructions: { value: string; recordName?: string } };
}

const submission = (policyVersion = '2026-10') => ({ category: 'technology', description: 'Independent reviews of developer tools and hardware.', language: 'en', country: 'US', policyVersion, acceptPolicies: true });

describe('verification workflow', () => {
  it('starts as a draft, moves to pending on a challenge, and to verified (not approved) on success', async () => {
    const p = await publisher();
    const site = await addSite(p, 'reviews.example.co');
    expect(site.status).toBe('draft');
    const c = await challenge(p, site.id, 'dns_txt');
    expect(c.instructions.recordName).toBe('_blissnova-verification.reviews.example.co');
    world.txt.set(c.instructions.recordName!, [[c.instructions.value]]);
    const r = await p.cl.post(`/api/v1/orgs/${p.org}/sites/${site.id}/verification/check`);
    expect(r.body.verified).toBe(true);
    expect(r.body.data.status).toBe('verified');
    expect(r.body.data.verification.scope).toBe('zone');
    const row = (await h.db.query('SELECT status, approved_at, verification_method FROM sites WHERE id = $1', [site.id])).rows[0];
    expect(row.status).toBe('verified');
    expect(row.approved_at).toBeNull();
    expect(row.verification_method).toBe('dns_txt');
  });

  it('records every attempt, failures included, in an append-only history', async () => {
    const p = await publisher();
    const site = await addSite(p, 'history.example.co');
    await challenge(p, site.id, 'meta_tag');
    const miss = await p.cl.post(`/api/v1/orgs/${p.org}/sites/${site.id}/verification/check`);
    expect(miss.body.verified).toBe(false);
    expect(miss.body.outcome).toBe('error');
    const rows = (await h.db.query('SELECT id, outcome FROM site_verification_attempts WHERE site_id = $1', [site.id])).rows;
    expect(rows.map((r) => r.outcome)).toEqual(['error']);
    await expect(h.db.query(`UPDATE site_verification_attempts SET outcome = 'success' WHERE id = $1`, [rows[0]!.id])).rejects.toThrow(/append-only/);
  });

  it('a file or meta-tag proof covers the host only, so subdomains are refused', async () => {
    const p = await publisher();
    const site = await addSite(p, 'hostonly.example.co');
    const c = await challenge(p, site.id, 'html_file');
    world.pages.set('https://hostonly.example.co/.well-known/blissnova-verification.txt', { status: 200, body: c.instructions.value, contentType: 'text/plain' });
    expect((await p.cl.post(`/api/v1/orgs/${p.org}/sites/${site.id}/verification/check`)).body.verified).toBe(true);
    const patch = await p.cl.patch(`/api/v1/orgs/${p.org}/sites/${site.id}`, { allowedDomains: ['blog.hostonly.example.co'] });
    expect(patch.status).toBe(400);
    expect(patch.body.error.message).toMatch(/DNS TXT/);
  });

  it('refuses an expired challenge and leaves the site unverified', async () => {
    const p = await publisher();
    const site = await addSite(p, 'late.example.co');
    const c = await challenge(p, site.id, 'dns_txt');
    world.txt.set(c.instructions.recordName!, [[c.instructions.value]]);
    await h.db.query(`UPDATE site_verifications SET expires_at = now() - interval '1 minute' WHERE id = $1`, [c.id]);
    const r = await p.cl.post(`/api/v1/orgs/${p.org}/sites/${site.id}/verification/check`);
    expect(r.body.verified).toBe(false);
    expect(r.body.outcome).toBe('expired');
    expect((await h.db.query('SELECT verified_at FROM sites WHERE id = $1', [site.id])).rows[0].verified_at).toBeNull();
  });

  it('a superseded token cannot be replayed after a new challenge is issued', async () => {
    const p = await publisher();
    const site = await addSite(p, 'replay.example.co');
    const first = await challenge(p, site.id, 'dns_txt');
    await challenge(p, site.id, 'dns_txt');
    world.txt.set(first.instructions.recordName!, [[first.instructions.value]]);
    const r = await p.cl.post(`/api/v1/orgs/${p.org}/sites/${site.id}/verification/check`);
    expect(r.body.verified).toBe(false);
    expect(r.body.outcome).toBe('mismatch');
  });

  it("another site's proof does not verify this one", async () => {
    const a = await publisher();
    const b = await publisher();
    const siteA = await addSite(a, 'alpha.example.co');
    const siteB = await addSite(b, 'beta.example.co');
    const ca = await challenge(a, siteA.id, 'dns_txt');
    await challenge(b, siteB.id, 'dns_txt');
    // B publishes A's token on its own name.
    world.txt.set('_blissnova-verification.beta.example.co', [[ca.instructions.value]]);
    expect((await b.cl.post(`/api/v1/orgs/${b.org}/sites/${siteB.id}/verification/check`)).body.verified).toBe(false);
  });

  it('tokens are unique and carry at least 192 bits of randomness', async () => {
    const p = await publisher();
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const site = await addSite(p, `t${i}.example.co`);
      const c = await challenge(p, site.id, 'html_file');
      expect(c.instructions.value).toMatch(/^bnv_[A-Za-z0-9_-]{32}$/);
      tokens.add(c.instructions.value);
    }
    expect(tokens.size).toBe(5);
  });

  it('rate-limits checks per hostname', async () => {
    const p = await publisher();
    const site = await addSite(p, 'busy.example.co');
    await challenge(p, site.id, 'dns_txt');
    await h.db.query(`INSERT INTO platform_settings (key, value) VALUES ('verification', '{"maxChecksPerHostPerHour": 2}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    h.app.ctx.settings.invalidate();
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await p.cl.post(`/api/v1/orgs/${p.org}/sites/${site.id}/verification/check`)).status);
    expect(codes).toEqual([200, 200, 429]);
  });
});

describe('review after verification', () => {
  it('cannot be submitted before verification, and cannot be approved before submission', async () => {
    const p = await publisher();
    const a = await admin();
    const site = await addSite(p, 'early.example.co');
    expect((await p.cl.post(`/api/v1/orgs/${p.org}/sites/${site.id}/submit`, submission())).status).toBe(409);
    expect((await a.cl.post(`/api/v1/admin/sites/${site.id}/approve`, {})).status).toBe(409);
  });

  it('requires acceptance of the current policy version', async () => {
    const p = await publisher();
    const site = await makeSite(h.db, { orgId: p.org, domain: 'policy.example.co', status: 'verified' });
    expect((await p.cl.post(`/api/v1/orgs/${p.org}/sites/${site.id}/submit`, { ...submission(), acceptPolicies: false })).status).toBe(400);
    expect((await p.cl.post(`/api/v1/orgs/${p.org}/sites/${site.id}/submit`, submission('2020-01'))).status).toBe(409);
    expect((await p.cl.post(`/api/v1/orgs/${p.org}/sites/${site.id}/submit`, submission())).status).toBe(200);
  });

  it('applies configured eligibility rules at submission', async () => {
    const p = await publisher();
    const site = await makeSite(h.db, { orgId: p.org, domain: 'elig.example.co', status: 'verified' });
    await h.db.query(`INSERT INTO platform_settings (key, value) VALUES ('eligibility', '{"allowedCountries": ["GB"]}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    h.app.ctx.settings.invalidate();
    const r = await p.cl.post(`/api/v1/orgs/${p.org}/sites/${site.id}/submit`, submission());
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/US/);
  });

  it('walks submitted -> under review -> approved with a review record at each step', async () => {
    const p = await publisher();
    const a = await admin();
    const site = await makeSite(h.db, { orgId: p.org, domain: 'flow.example.co', status: 'verified' });
    expect((await p.cl.post(`/api/v1/orgs/${p.org}/sites/${site.id}/submit`, submission())).status).toBe(200);
    expect((await a.cl.post(`/api/v1/admin/sites/${site.id}/start-review`, {})).status).toBe(200);
    expect((await a.cl.post(`/api/v1/admin/sites/${site.id}/reject`, {})).status).toBe(400); // reason required
    const ok = await a.cl.post(`/api/v1/admin/sites/${site.id}/approve`, { checklist: { originalContent: true, privacyPolicy: true } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const reviews = (await h.db.query('SELECT action, to_status FROM site_reviews WHERE site_id = $1 ORDER BY created_at', [site.id])).rows;
    expect(reviews.map((r) => r.action)).toEqual(['submit', 'start-review', 'approve']);
    const tag = await p.cl.get(`/api/v1/orgs/${p.org}/sites/${site.id}/tag`);
    expect(tag.body.data.available).toBe(true);
  });

  it('withholds the ad tag until the site is approved', async () => {
    const p = await publisher();
    const site = await makeSite(h.db, { orgId: p.org, domain: 'notyet.example.co', status: 'submitted' });
    const tag = await p.cl.get(`/api/v1/orgs/${p.org}/sites/${site.id}/tag`);
    expect(tag.status).toBe(200);
    expect(tag.body.data.available).toBe(false);
    expect(JSON.stringify(tag.body)).not.toMatch(/pk_/);
  });

  it('revoking a verification takes the site out of service and is audited', async () => {
    const p = await publisher();
    const a = await admin();
    const site = await makeSite(h.db, { orgId: p.org, domain: 'gone.example.co', status: 'approved' });
    // Revocation needs a recent re-authentication.
    expect((await a.cl.post(`/api/v1/admin/sites/${site.id}/revoke-verification`, { reason: 'Domain changed hands' })).status).toBe(403);
    expect((await a.cl.post('/api/v1/auth/step-up', { password: a.user.password })).status).toBe(200);
    // (the 403 above is the step-up requirement, not a missing permission)
    expect((await a.cl.post(`/api/v1/admin/sites/${site.id}/revoke-verification`, { reason: 'Domain changed hands' })).status).toBe(200);
    const row = (await h.db.query('SELECT status, verified_at FROM sites WHERE id = $1', [site.id])).rows[0];
    expect(row.status).toBe('verification_pending');
    expect(row.verified_at).toBeNull();
    expect((await h.db.query(`SELECT 1 FROM audit_logs WHERE action = 'site.revoke_verification' AND resource_id = $1`, [site.id])).rowCount).toBe(1);
  });
});

describe('development verification simulator', () => {
  it('verifies a reserved local hostname and labels it as simulated', async () => {
    const p = await publisher();
    const site = await addSite(p, 'demo-publisher.localhost');
    const r = await p.cl.post(`/api/v1/orgs/${p.org}/sites/${site.id}/verification/simulate`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.simulated).toBe(true);
    expect(r.body.data.verification.simulated).toBe(true);
    expect(r.body.data.verification.history[0].detail).toMatch(/SIMULATED/);
    expect(r.body.data.status).toBe('verified');
  });

  it('refuses to simulate a domain that could exist on the public internet', async () => {
    const p = await publisher();
    const site = await addSite(p, 'somebody-elses-site.com');
    const r = await p.cl.post(`/api/v1/orgs/${p.org}/sites/${site.id}/verification/simulate`);
    expect(r.status).toBe(400);
    expect((await h.db.query('SELECT verified_at FROM sites WHERE id = $1', [site.id])).rows[0].verified_at).toBeNull();
  });

  it('does not exist in production, even with the flag forced on', async () => {
    const p = await publisher(prodH);
    const site = await makeSite(prodH.db, { orgId: p.org, domain: 'demo-publisher.localhost', status: 'verification_pending' });
    const r = await p.cl.post(`/api/v1/orgs/${p.org}/sites/${site.id}/verification/simulate`);
    expect(r.status).toBe(404);
    expect((await prodH.db.query('SELECT verified_at FROM sites WHERE id = $1', [site.id])).rows[0].verified_at).toBeNull();
  });

  it('a simulated verification never serves ads in production', async () => {
    const p = await publisher(prodH);
    const site = await makeSite(prodH.db, { orgId: p.org, domain: 'copied.example.co', status: 'approved' });
    await prodH.db.query(`UPDATE sites SET verification_simulated = true WHERE id = $1`, [site.id]);
    await prodH.db.query(`UPDATE organizations SET status = 'approved' WHERE id = $1`, [p.org]);
    const serve = (cl: Client) => cl.req('POST', '/api/v1/serve', { body: { siteKey: site.publicKey, units: [{ slot: 'some_slot' }], page: { url: 'https://copied.example.co/a' }, pv: 'pageview-0001' }, noCsrf: true });
    const r = await serve(new Client(prodH.app));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('inactive');
    expect(r.body.ads.every((a: { ad: unknown }) => a.ad === null)).toBe(true);
    // Control: the same site without the simulated flag is recognised.
    await prodH.db.query(`UPDATE sites SET verification_simulated = false WHERE id = $1`, [site.id]);
    invalidateServingCache(prodH.app.ctx);
    expect((await serve(new Client(prodH.app))).body.status).not.toBe('inactive');
  });
});

describe('production configuration', () => {
  const prodEnv = (extra: Record<string, string> = {}) => ({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@db:5432/bn',
    APP_SECRET: 'Zq8vN3kLw0pXr7sTb2mYc5hJd9fGa1eU',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    TRACKING_TOKEN_KEYS: `k1:${Buffer.alloc(32, 9).toString('base64')}`,
    PUBLIC_SITE_URL: 'https://ads.blissnova.invalid',
    PUBLIC_API_URL: 'https://api.blissnova.invalid',
    CORS_ORIGINS: 'https://ads.blissnova.invalid',
    EMAIL_PROVIDER: 'disabled',
    ...extra,
  }) as NodeJS.ProcessEnv;

  it('starts with a safe production configuration', () => {
    expect(loadConfig(prodEnv()).isProd).toBe(true);
  });

  for (const [name, extra, pattern] of [
    ['the verification simulator', { ENABLE_DEV_VERIFICATION_SIMULATOR: 'true' }, /ENABLE_DEV_VERIFICATION_SIMULATOR/],
    ['simulated payments', { ENABLE_DEV_PAYMENTS: 'true' }, /ENABLE_DEV_PAYMENTS/],
    ['plain-HTTP verification', { VERIFICATION_ALLOW_HTTP: 'true' }, /VERIFICATION_ALLOW_HTTP/],
    ['demo seeding', { SEED_DEMO_DATA: 'true' }, /SEED_DEMO_DATA/],
    ['a placeholder secret', { APP_SECRET: 'change-me-change-me-change-me-change-me' }, /APP_SECRET/],
    ['localhost URLs', { PUBLIC_API_URL: 'http://localhost:4000' }, /localhost/],
    ['insecure cookies', { COOKIE_SECURE: 'false' }, /COOKIE_SECURE/],
    ['emails written to the log', { EMAIL_PROVIDER: 'log' }, /EMAIL_PROVIDER/],
  ] as const) {
    it(`refuses to start with ${name}`, () => {
      expect(() => loadConfig(prodEnv(extra as Record<string, string>))).toThrow(pattern);
    });
  }

  it('never registers the simulated payment provider in production', () => {
    const c = { ...testConfig(), NODE_ENV: 'production' as const, isProd: true, ENABLE_DEV_PAYMENTS: true };
    const reg = new PaymentProviderRegistry(c);
    expect(reg.list().map((p) => p.id)).not.toContain('dev_simulated');
  });

  it('registers it in development when asked', () => {
    const reg = new PaymentProviderRegistry(testConfig());
    expect(reg.list().map((p) => p.id)).toContain('dev_simulated');
  });
});

