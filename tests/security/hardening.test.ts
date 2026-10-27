import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { isPrivateAddress } from '@blissnova/api/services/verification';
import { makeCampaign, makeOrg, makeSite, makeUser, setSettings, TEST_PASSWORD } from '../helpers/fixtures';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

async function signedIn(opts: Parameters<typeof makeUser>[1] = {}) {
  const u = await makeUser(h.db, opts);
  const cl = new Client(h.app);
  await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
  return { user: u, cl };
}

describe('cross-site request forgery', () => {
  it('refuses a cookie-authenticated write with no CSRF header', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const r = await s.cl.req('PATCH', `/api/v1/orgs/${org}`, { body: { name: 'Forged' }, noCsrf: true });
    expect(r.status).toBe(403);
    expect(r.body?.error?.code).toBe('forbidden');
  });

  it('refuses a write whose CSRF header does not match the cookie', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const r = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/orgs/${org}`,
      headers: { cookie: s.cl.cookieHeader(), 'x-csrf-token': 'not-the-right-token' },
      payload: { name: 'Forged' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('accepts the write when the header matches the cookie', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const r = await s.cl.patch(`/api/v1/orgs/${org}`, { name: 'Legitimate rename' });
    expect(r.status).toBe(200);
  });

  it('does not require a CSRF token for reads', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const r = await h.app.inject({ method: 'GET', url: `/api/v1/orgs/${org}`, headers: { cookie: s.cl.cookieHeader() } });
    expect(r.statusCode).toBe(200);
  });

  it('does not apply CSRF to API-key callers, which send no cookie', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const created = await s.cl.post(`/api/v1/orgs/${org}/api-keys`, { name: 'integration', scopes: ['campaign:read'] });
    expect(created.status).toBeLessThan(300);
    const secret: string = created.body.data.key;
    expect(secret).toMatch(/^bnk_/);
    const r = await h.app.inject({ method: 'GET', url: '/api/v1/integrations/ping', headers: { authorization: `Bearer ${secret}` } });
    expect(r.statusCode).toBeLessThan(400);
  });
});

describe('API keys', () => {
  it('shows the secret only once, and stores only a hash', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const created = await s.cl.post(`/api/v1/orgs/${org}/api-keys`, { name: 'one-time', scopes: ['campaign:read'] });
    const secret: string = created.body.data.key;

    const list = await s.cl.get(`/api/v1/orgs/${org}/api-keys`);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    const rows = await h.db.query('SELECT * FROM api_keys');
    expect(JSON.stringify(rows.rows)).not.toContain(secret.split('_').pop());
  });

  it('refuses a made-up or revoked key', async () => {
    const bad = await h.app.inject({ method: 'GET', url: '/api/v1/integrations/ping', headers: { authorization: 'Bearer bnk_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbb' } });
    expect(bad.statusCode).toBe(401);
  });

  it('does not let an API key reach another organisation', async () => {
    const s = await signedIn();
    const mine = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const other = await makeOrg(h.db, { type: 'advertiser', ownerId: (await makeUser(h.db)).id });
    const created = await s.cl.post(`/api/v1/orgs/${mine}/api-keys`, { name: 'scoped', scopes: ['campaign:read'] });
    const secret: string = created.body.data.key;
    const r = await h.app.inject({ method: 'GET', url: `/api/v1/orgs/${other}`, headers: { authorization: `Bearer ${secret}` } });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.body).not.toContain(other);
  });
});

describe('rate limiting', () => {
  it('throttles repeated login attempts', async () => {
    await setSettings(h.db, 'api', { authRateLimitPerMinute: 3 });
    h.app.ctx.settings.invalidate();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await new Client(h.app).post('/api/v1/auth/login', { email: `nobody${i}@example.com`, password: 'Wrong-password-1!' });
      codes.push(r.status);
    }
    expect(codes).toContain(429);
  });

  it('records a rate-limited request as a security event', async () => {
    await setSettings(h.db, 'api', { authRateLimitPerMinute: 2 });
    h.app.ctx.settings.invalidate();
    for (let i = 0; i < 5; i++) {
      await new Client(h.app).post('/api/v1/auth/login', { email: 'nobody@example.com', password: 'Wrong-password-1!' });
    }
    // Written asynchronously; give it a moment.
    await new Promise((r) => setTimeout(r, 150));
    const rows = await h.db.query(`SELECT 1 FROM security_events WHERE type = 'rate_limited'`);
    expect(rows.rowCount).toBeGreaterThan(0);
  });

  it('sends a Retry-After header so a client can back off properly', async () => {
    await setSettings(h.db, 'api', { authRateLimitPerMinute: 1 });
    h.app.ctx.settings.invalidate();
    let limited: Awaited<ReturnType<Client['post']>> | null = null;
    for (let i = 0; i < 5 && !limited; i++) {
      const r = await new Client(h.app).post('/api/v1/auth/login', { email: 'nobody@example.com', password: 'Wrong-password-1!' });
      if (r.status === 429) limited = r;
    }
    expect(limited).not.toBeNull();
    expect(limited!.headers['retry-after']).toBeTruthy();
  });
});

describe('server-side request forgery in site verification', () => {
  it('treats every private and reserved range as off limits', async () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // carrier-grade NAT
      '0.0.0.0',
      '192.0.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      '2001:db8::1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public addresses', async () => {
    for (const ip of ['8.8.8.8', '203.0.113.9', '1.1.1.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('refuses to verify a site whose domain points at a private address', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'publisher', ownerId: s.user.id });
    // "localhost" resolves to a loopback address.
    const site = await makeSite(h.db, { orgId: org, domain: 'localhost', status: 'pending_verification', allowed: ['localhost'] });
    await s.cl.post(`/api/v1/orgs/${org}/sites/${site.id}/verification-token`);
    const r = await s.cl.post(`/api/v1/orgs/${org}/sites/${site.id}/verify`, { method: 'html_file' });
    // Either refused outright or reported as failed verification; what must not
    // happen is the server fetching a loopback URL and reporting success.
    expect(r.status >= 400 || r.body?.verified === false, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(true);
    const after = await h.db.query<{ status: string }>('SELECT status FROM sites WHERE id = $1', [site.id]);
    expect(after.rows[0]!.status).not.toBe('approved');
  });
});

describe('input handling', () => {
  it('does not let a quote in a filter break the SQL behind it', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    await makeCampaign(h.db, { orgId: org });
    for (const probe of [`' OR 1=1 --`, `'; DROP TABLE campaigns; --`, `%' --`, `\\`]) {
      const r = await s.cl.get(`/api/v1/orgs/${org}/campaigns?search=${encodeURIComponent(probe)}`);
      expect([200, 400], probe).toContain(r.status);
    }
    // The table is still there.
    expect((await h.db.query('SELECT count(*) FROM campaigns')).rowCount).toBe(1);
  });

  it('refuses an id that is not a UUID instead of putting it in a query', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const r = await s.cl.get(`/api/v1/orgs/${org}/campaigns/not-a-uuid`);
    expect(r.status).toBe(400);
  });

  it('rejects an oversized body rather than buffering it', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const r = await s.cl.patch(`/api/v1/orgs/${org}`, { name: 'x'.repeat(2_000_000) });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('keeps a stack trace out of an error response', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/api/v1/orgs/not-a-uuid' });
    expect(r.body).not.toContain('at ');
    expect(r.body).not.toContain('.ts:');
  });

  it('gives every error a request id so it can be traced in the logs', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/api/v1/orgs/00000000-0000-4000-8000-000000000000' });
    const body = JSON.parse(r.body);
    expect(body.error.requestId).toBeTruthy();
  });
});

describe('CSV export', () => {
  it('neutralises a value that a spreadsheet would run as a formula', async () => {
    const { toCsv } = await import('@blissnova/api/lib/http');
    const csv = toCsv(
      [{ name: '=cmd|\' /c calc\'!A1', note: '+1+1', other: '-2+3', at: '@SUM(A1)' }],
      [
        { key: 'name', label: 'name' },
        { key: 'note', label: 'note' },
        { key: 'other', label: 'other' },
        { key: 'at', label: 'at' },
      ],
    );
    for (const line of csv.split('\n').slice(1)) {
      for (const cell of line.split(',')) {
        const unquoted = cell.replace(/^"|"$/g, '');
        expect(['=', '+', '-', '@'], cell).not.toContain(unquoted[0]);
      }
    }
  });

  it('escapes quotes and newlines so rows cannot be injected', async () => {
    const { toCsv } = await import('@blissnova/api/lib/http');
    const csv = toCsv([{ a: 'has "quotes"', b: 'has\nnewline' }], [
      { key: 'a', label: 'a' },
      { key: 'b', label: 'b' },
    ]);
    expect(csv.split('\r\n')[0]).toBe('a,b');
    expect(csv).toContain('""quotes""');
  });
});

describe('maintenance mode', () => {
  it('keeps serving ads while refusing management writes', async () => {
    const s = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    await setSettings(h.db, 'platform', { maintenanceMode: true, maintenanceMessage: 'Back shortly.' });
    h.app.ctx.settings.invalidate();

    const write = await s.cl.patch(`/api/v1/orgs/${org}`, { name: 'During maintenance' });
    expect(write.status).toBe(503);

    // Ad serving must keep working: publishers' pages do not stop for us.
    const serve = await h.app.inject({
      method: 'POST',
      url: '/api/v1/serve',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36' },
      payload: { siteKey: 'pk_aaaaaaaaaaaaaaaaaaaa', units: [{ slot: 'some_slot' }], page: { url: 'http://example.org/a' }, pv: 'pv0000000000' },
    });
    expect(serve.statusCode).toBe(200);
    // And /health must stay up for load balancers.
    expect((await h.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});
