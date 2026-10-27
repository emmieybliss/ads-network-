import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adsTxtLine, matchAdsTxt, parseAdsTxt } from '@blissnova/api/services/adstxt';
import type { SafeFetchOptions, SafeFetchResult } from '@blissnova/api/services/verification';
import { createHarness, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { makeOrg, makeSite, makeUser, TEST_PASSWORD } from '../helpers/fixtures';

const pages = new Map<string, { status: number; body: string; contentType?: string }>();
const fakeFetch = async (url: string, _opts: SafeFetchOptions): Promise<SafeFetchResult> => {
  const p = pages.get(url.replace(/^http:/, 'https:')) ?? { status: 404, body: 'not found', contentType: 'text/plain' };
  return { status: p.status, body: p.body, contentType: p.contentType ?? 'text/plain', finalUrl: url, redirects: [] };
};

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ ADS_TXT_DOMAIN: 'network.example' }, { overrides: { verifier: { fetch: fakeFetch } } });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
  pages.clear();
});

describe('ads.txt parsing', () => {
  const body = [
    '# ads.txt for pub.example.org',
    'contact=ads@pub.example.org',
    'google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0',
    'NETWORK.example , seller-1 , direct   # our line',
    'other.example, seller-1, RESELLER',
    '',
  ].join('\r\n');

  it('reads data records and skips comments, variables and blank lines', () => {
    const r = parseAdsTxt(body);
    expect(r).toHaveLength(3);
    expect(r[1]).toEqual({ domain: 'network.example', accountId: 'seller-1', relationship: 'DIRECT' });
  });

  it('finds a DIRECT line for the network and seller id', () => {
    expect(matchAdsTxt(parseAdsTxt(body), 'network.example', 'seller-1').status).toBe('found');
  });

  it('flags a RESELLER line or a different seller id as needing a fix', () => {
    expect(matchAdsTxt(parseAdsTxt('network.example, seller-1, RESELLER'), 'network.example', 'seller-1').status).toBe('mismatch');
    expect(matchAdsTxt(parseAdsTxt('network.example, seller-2, DIRECT'), 'network.example', 'seller-1').status).toBe('mismatch');
  });

  it('reports missing when the network is not listed', () => {
    expect(matchAdsTxt(parseAdsTxt('google.com, pub-1, DIRECT'), 'network.example', 'seller-1').status).toBe('missing');
  });

  it('formats the line publishers copy', () => {
    expect(adsTxtLine('network.example', 'abc')).toBe('network.example, abc, DIRECT');
  });
});

async function publisher(opts: { status?: string; siteStatus?: string; name?: string; domain?: string } = {}) {
  const u = await makeUser(h.db);
  const org = await makeOrg(h.db, { type: 'publisher', ownerId: u.id, status: opts.status, name: opts.name });
  const site = await makeSite(h.db, { orgId: org, domain: opts.domain ?? 'pub.example.org', status: opts.siteStatus });
  const cl = new Client(h.app);
  await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
  return { org, site, cl };
}

describe('ads.txt check through the API', () => {
  it('gives the publisher its line, built from the configured network domain', async () => {
    const p = await publisher();
    const r = await p.cl.get(`/api/v1/orgs/${p.org}/sites/${p.site.id}/ads-txt`);
    expect(r.status).toBe(200);
    expect(r.body.data.line).toBe(`network.example, ${p.org}, DIRECT`);
    expect(r.body.data.status).toBe('unchecked');
  });

  it('records found, missing and mismatch results', async () => {
    const p = await publisher();
    const url = `/api/v1/orgs/${p.org}/sites/${p.site.id}/ads-txt/check`;
    expect((await p.cl.post(url)).body.data.status).toBe('missing');
    pages.set('https://pub.example.org/ads.txt', { status: 200, body: `network.example, ${p.org}, RESELLER\n` });
    expect((await p.cl.post(url)).body.data.status).toBe('mismatch');
    pages.set('https://pub.example.org/ads.txt', { status: 200, body: `google.com, pub-1, DIRECT\nnetwork.example, ${p.org}, DIRECT\n` });
    const ok = await p.cl.post(url);
    expect(ok.body.data.status).toBe('found');
    expect(ok.body.data.checkedAt).toBeTruthy();
    const row = (await h.db.query('SELECT ads_txt_status FROM sites WHERE id = $1', [p.site.id])).rows[0];
    expect(row.ads_txt_status).toBe('found');
  });

  it('refuses an HTML page served in place of ads.txt', async () => {
    const p = await publisher();
    pages.set('https://pub.example.org/ads.txt', { status: 200, contentType: 'text/html', body: `<html><body>network.example, ${p.org}, DIRECT</body></html>` });
    expect((await p.cl.post(`/api/v1/orgs/${p.org}/sites/${p.site.id}/ads-txt/check`)).body.data.status).toBe('error');
  });

  it('will not check an unverified site', async () => {
    const p = await publisher({ siteStatus: 'draft' });
    expect((await p.cl.post(`/api/v1/orgs/${p.org}/sites/${p.site.id}/ads-txt/check`)).status).toBe(409);
  });

  it('will not show another publisher\'s ads.txt details', async () => {
    const a = await publisher();
    const b = await publisher({ domain: 'b.example.org' });
    expect([403, 404]).toContain((await b.cl.get(`/api/v1/orgs/${a.org}/sites/${a.site.id}/ads-txt`)).status);
  });
});

describe('sellers.json', () => {
  it('lists approved publishers with an approved site, and hides confidential ones', async () => {
    const shown = await publisher({ name: 'Shown Media' });
    const hidden = await publisher({ name: 'Hidden Media', domain: 'hidden.example.org' });
    const pending = await publisher({ name: 'Pending Media', status: 'pending', domain: 'pending.example.org' });
    await hidden.cl.patch(`/api/v1/orgs/${hidden.org}`, { sellersJsonConfidential: true });

    const r = await h.app.inject({ method: 'GET', url: '/sellers.json' });
    expect(r.statusCode).toBe(200);
    const doc = JSON.parse(r.body);
    expect(doc.version).toBe('1.0');
    const byId = new Map(doc.sellers.map((s: any) => [s.seller_id, s]));
    expect(byId.get(shown.org)).toEqual({ seller_id: shown.org, seller_type: 'PUBLISHER', name: 'Shown Media', domain: 'pub.example.org' });
    expect(byId.get(hidden.org)).toEqual({ seller_id: hidden.org, seller_type: 'PUBLISHER', is_confidential: 1 });
    expect(byId.has(pending.org)).toBe(false);
  });
});
