/**
 * Country targeting from a GeoIP database that keeps itself current, live
 * reports, and two-step verification with backup codes and trusted devices.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BROWSER_UA, createHarness, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { fundOrg, makeCampaign, makeCreative, makeOrg, makeSite, makeUnit, makeUser, reserve, setSettings, TEST_PASSWORD, uniq } from '../helpers/fixtures';

const FIXTURE = new URL('../fixtures/GeoIP2-Country-Test.mmdb', import.meta.url).pathname;
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

const today = () => new Date().toISOString().slice(0, 10);

async function login(email: string, extra: Record<string, unknown> = {}, cl = new Client(h.app)) {
  const r = await cl.post('/api/v1/auth/login', { email, password: TEST_PASSWORD, ...extra });
  return { cl, r };
}

// ------------------------------------------------------------------ GeoIP

describe('GeoIP', () => {
  let server: Server;
  let base = '';
  let served: Buffer = Buffer.alloc(0);
  let hits: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url?.includes('missing')) { res.statusCode = 404; res.end(); return; }
      res.end(served);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => { hits = []; });

  async function service(over: Partial<import('@blissnova/api/lib/geo').GeoIpOptions> = {}) {
    const { GeoIpService } = await import('@blissnova/api/lib/geo');
    const dir = mkdtempSync(join(tmpdir(), 'geo-'));
    return new GeoIpService({ path: join(dir, 'country.mmdb'), header: '', autoUpdate: true, downloadUrl: `${base}/db-{YYYY}-{MM}.mmdb.gz`, localCountry: '', allowLocalTest: true, warn: () => undefined, ...over });
  }

  it('downloads the monthly database, gunzips it, checks it and swaps it in without a restart', async () => {
    served = gzipSync(readFileSync(FIXTURE));
    const geo = await service();
    expect(geo.resolve('81.2.69.160')).toEqual({ country: 'ZZ', source: 'unknown' });
    const r = await geo.update();
    expect(r.updated).toBe(true);
    const ym = new Date().toISOString().slice(0, 7);
    expect(hits[0]).toBe(`/db-${ym}.mmdb.gz`);
    expect(geo.resolve('81.2.69.160')).toEqual({ country: 'GB', source: 'database' });
    expect(existsSync(geo.status().database!.path)).toBe(true);
    expect(geo.status().autoUpdate).toMatchObject({ enabled: true, source: '127.0.0.1:' + base.split(':').pop(), lastError: null });
  });

  it('falls back to last month early in a month and keeps the old database when a download is bad', async () => {
    served = readFileSync(FIXTURE); // plain .mmdb works too
    const geo = await service({ downloadUrl: `${base}/{YYYY}-{MM}-missing-or-old.mmdb` });
    // Every URL answers 404 here, so both months are tried.
    const miss = await geo.update();
    expect(miss.updated).toBe(false);
    expect(hits).toHaveLength(2);
    const ok = await (await service()).update();
    expect(ok.updated).toBe(true);

    // A good database, then junk: the good one stays in use.
    const g2 = await service();
    await g2.update();
    served = Buffer.from('not a database');
    const bad = await g2.update({ force: true });
    expect(bad.updated).toBe(false);
    expect(g2.status().autoUpdate.lastError).toMatch(/127\.0\.0\.1/);
    expect(g2.resolve('81.2.69.160').country).toBe('GB');
  });

  it('prefers the CDN header, then the database, then the local test country for private addresses', async () => {
    served = gzipSync(readFileSync(FIXTURE));
    const geo = await service({ localCountry: 'DE' });
    await geo.update();
    expect(geo.resolve('81.2.69.160', 'fr')).toEqual({ country: 'FR', source: 'header' });
    expect(geo.resolve('81.2.69.160', 'XX')).toEqual({ country: 'GB', source: 'database' });
    expect(geo.resolve('127.0.0.1')).toEqual({ country: 'DE', source: 'local_test' });
    expect(geo.resolve('192.168.1.20')).toEqual({ country: 'DE', source: 'local_test' });
    expect(geo.resolve('8.8.4.4')).toEqual({ country: 'ZZ', source: 'unknown' });
    const prod = await service({ localCountry: 'DE', allowLocalTest: false });
    expect(prod.resolve('127.0.0.1').country).toBe('ZZ');
    expect(() => prod.setLocalCountry('US')).toThrow();
  });

  it('refuses a local test country in production', async () => {
    const { productionProblems, loadConfig } = await import('@blissnova/api/config');
    const c = loadConfig({ ...process.env, NODE_ENV: 'test', DATABASE_URL: 'postgres://x', APP_SECRET: 'x'.repeat(40), ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), TRACKING_TOKEN_KEYS: 'k1:' + Buffer.alloc(32).toString('base64'), GEO_LOCAL_COUNTRY: 'us' } as NodeJS.ProcessEnv);
    expect(c.GEO_LOCAL_COUNTRY).toBe('US');
    expect(productionProblems(c, ['https://dash.example.com']).join('\n')).toMatch(/GEO_LOCAL_COUNTRY must be empty/);
  });

  it('serves country-targeted and country-excluded campaigns by the visitor country, with an admin lookup and local test country', async () => {
    served = gzipSync(readFileSync(FIXTURE));
    const geo = await service();
    await geo.update();
    const saved = h.app.ctx.geoip;
    h.app.ctx.geoip = geo;
    try {
      const advUser = await makeUser(h.db);
      const pubUser = await makeUser(h.db);
      const adv = await makeOrg(h.db, { type: 'advertiser', ownerId: advUser.id });
      const pub = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id });
      const site = await makeSite(h.db, { orgId: pub, domain: 'pub.example.org' });
      const unit = await makeUnit(h.db, { siteId: site.id, formats: ['image'], width: 300, height: 250 });
      await fundOrg(h.db, adv, '500');
      const camp = await makeCampaign(h.db, { orgId: adv, rate: '4.00', lifetime: '100', daily: null });
      await makeCreative(h.db, { campaignId: camp, orgId: adv, format: 'image', width: 300, height: 250 });
      await reserve(h.db, camp);
      const advCl = (await login(advUser.email)).cl;
      // All countries except the UK, through the API, as the country picker sends it.
      const cur = (await advCl.get(`/api/v1/orgs/${adv}/campaigns/${camp}`)).body.data;
      const put = await advCl.req('PATCH', `/api/v1/orgs/${adv}/campaigns/${camp}`, { body: { targeting: { ...cur.targeting, countries: [], excludeCountries: ['GB', 'GB'] } } });
      expect(put.status, JSON.stringify(put.body)).toBeLessThan(300);
      expect((await advCl.get(`/api/v1/orgs/${adv}/campaigns/${camp}`)).body.data.targeting.excludeCountries).toEqual(['GB']);
      // Targeting edits go back to review; approve it again for serving.
      await h.db.query(`UPDATE campaigns SET status = 'active' WHERE id = $1`, [camp]);

      const { invalidateServingCache } = await import('@blissnova/api/services/serving');
      invalidateServingCache(h.app.ctx);
      const serve = async (ip: string) => {
        const r = await h.app.inject({ method: 'POST', url: '/api/v1/serve', remoteAddress: ip, headers: { 'user-agent': BROWSER_UA, origin: 'http://pub.example.org' },
          payload: { siteKey: site.publicKey, units: [{ slot: unit.key }], page: { url: 'http://pub.example.org/a' }, pv: uniq('pv0000000000') } });
        const b = JSON.parse(r.body);
        return b.ads[0].ad as unknown;
      };
      expect(await serve('81.2.69.160')).toBeNull(); // GB: excluded
      expect(await serve('8.8.4.4')).toBeTruthy(); // unknown country: all-countries campaign still serves
      expect(await serve('127.0.0.1')).toBeTruthy();

      // Admin: look an address up, then make local visits count as the UK.
      const admin = await makeUser(h.db, { platformRole: 'super_admin' });
      const ad = (await login(admin.email)).cl;
      expect((await ad.post('/api/v1/admin/geo/lookup', { ip: '81.2.69.160' })).body.data).toMatchObject({ country: 'GB', source: 'database' });
      expect((await ad.post('/api/v1/admin/geo/lookup', { ip: 'nonsense' })).status).toBe(400);
      expect((await ad.put('/api/v1/admin/geo/local-country', { country: 'gb' })).body.data.localTestCountry).toBe('GB');
      expect(await serve('127.0.0.1')).toBeNull();
      expect((await ad.get('/api/v1/admin/system')).body.data.geo.database.description).toMatch(/^GeoIP2-Country \(built \d{4}-\d{2}-\d{2}\)$/);
      // Network country shares for the picker: shares only.
      expect((await advCl.get(`/api/v1/orgs/${adv}/targeting/countries`)).status).toBe(200);
    } finally {
      h.app.ctx.geoip = saved;
    }
  });
});

// ------------------------------------------------------------------ live reports

describe('live reports', () => {
  async function scenario() {
    const advUser = await makeUser(h.db);
    const pubUser = await makeUser(h.db);
    const adv = await makeOrg(h.db, { type: 'advertiser', ownerId: advUser.id });
    const pub = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id });
    const site = await makeSite(h.db, { orgId: pub, domain: 'live.example.org' });
    const unit = await makeUnit(h.db, { siteId: site.id, formats: ['image'], width: 300, height: 250 });
    const camp = await makeCampaign(h.db, { orgId: adv, rate: '4.00', lifetime: '100', daily: null });
    const creative = await makeCreative(h.db, { campaignId: camp, orgId: adv, format: 'image', width: 300, height: 250 });
    const insert = (n: number, at = 'now()') => h.db.query(
      `INSERT INTO ad_events (delivery_id, type, status, campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id, country, device, contextual, page_host, currency, occurred_at, billable, cost_micros, publisher_micros)
       SELECT gen_random_uuid(), 'render', 'valid', $1, $2, $3, $4, $5, $6, 'US', 'desktop', false, 'live.example.org', 'USD', ${at}, true, 4000, 2800 FROM generate_series(1, $7)`,
      [camp, typeof creative === 'string' ? creative : (creative as { id: string }).id, adv, site.id, unit.id, pub, n]);
    const valid = async () => Number((await h.db.query(`SELECT COALESCE(sum(valid_impressions), 0)::int AS n FROM daily_stats WHERE campaign_id = $1`, [camp])).rows[0].n);
    return { advUser, adv, insert, valid };
  }

  it('adds new events every pass without counting any twice, also next to full rebuilds', async () => {
    const { aggregateDay, rollupLive } = await import('@blissnova/api/services/events');
    const s = await scenario();
    await aggregateDay(h.db, today());
    await s.insert(3, "now() - interval '1 minute'");
    // Written now: the live pass leaves the last two seconds for the next pass.
    await new Promise((r) => setTimeout(r, 2100));
    expect(await rollupLive(h.db)).toBe(3);
    expect(await s.valid()).toBe(3);
    expect(await rollupLive(h.db)).toBe(0);
    expect(await s.valid()).toBe(3);
    // A queued event that happened earlier but is written now is still picked up.
    await s.insert(2, "now() - interval '20 minutes'");
    await new Promise((r) => setTimeout(r, 2100));
    expect(await rollupLive(h.db)).toBe(2);
    expect(await s.valid()).toBe(5);
    // A full rebuild agrees, and the live pass after it adds nothing.
    await s.insert(1);
    await aggregateDay(h.db, today());
    expect(await s.valid()).toBe(6);
    await new Promise((r) => setTimeout(r, 2100));
    expect(await rollupLive(h.db)).toBe(0);
    expect(await s.valid()).toBe(6);
  });

  it('tells dashboards when the reports changed', async () => {
    const { aggregateDay, rollupLive } = await import('@blissnova/api/services/events');
    const s = await scenario();
    const { cl } = await login(s.advUser.email);
    await aggregateDay(h.db, today());
    const before = (await cl.get('/api/v1/reports/freshness')).body.data;
    expect(before.changedAt).toBeTruthy();
    await new Promise((r) => setTimeout(r, 2100));
    await rollupLive(h.db);
    expect((await cl.get('/api/v1/reports/freshness')).body.data.changedAt).toBe(before.changedAt); // nothing new
    await s.insert(1, "now() - interval '5 seconds'");
    await new Promise((r) => setTimeout(r, 2100));
    await rollupLive(h.db);
    const after = (await cl.get('/api/v1/reports/freshness')).body.data;
    expect(after.changedAt).not.toBe(before.changedAt);
    expect(Date.parse(after.builtThrough)).toBeGreaterThan(Date.parse(before.builtThrough));
    expect((await new Client(h.app).get('/api/v1/reports/freshness')).status).toBe(401);
  });
});

// ------------------------------------------------------------------ two-step verification

describe('two-step verification', () => {
  async function totpFor(secret: string, offsetSteps = 0) {
    const { totp } = await import('@blissnova/api/lib/crypto');
    return totp(secret, Date.now() + offsetSteps * 30_000);
  }

  async function enrolled() {
    const u = await makeUser(h.db);
    const { cl } = await login(u.email);
    const setup = (await cl.post('/api/v1/auth/mfa/setup')).body;
    expect(setup.qrSvg).toMatch(/^<svg/);
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const on = await cl.post('/api/v1/auth/mfa/enable', { code: await totpFor(setup.secret, -1) });
    expect(on.status).toBe(200);
    expect(on.body.backupCodes).toHaveLength(10);
    expect(on.body.backupCodes[0]).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
    return { u, cl, secret: setup.secret as string, codes: on.body.backupCodes as string[] };
  }

  it('sets up with a QR code, gives ten backup codes stored only as hashes, and asks for a code at sign-in', async () => {
    const { u, codes } = await enrolled();
    const stored = (await h.db.query('SELECT code_hash FROM mfa_backup_codes WHERE user_id = $1', [u.id])).rows.map((r) => r.code_hash as string);
    expect(stored).toHaveLength(10);
    expect(stored.some((x) => codes.some((c) => x.includes(c.replace('-', ''))))).toBe(false);
    const first = await login(u.email);
    expect(first.r.body).toMatchObject({ mfaRequired: true });
    expect(first.cl.authenticated).toBe(false);
  });

  it('accepts each authenticator code once', async () => {
    const { u, secret } = await enrolled();
    const code = await totpFor(secret);
    expect((await login(u.email, { totp: code })).r.status).toBe(200);
    const again = await login(u.email, { totp: code });
    expect(again.r.status).toBe(401);
    expect(again.r.body.error.message).toMatch(/already used/);
    expect((await login(u.email, { totp: await totpFor(secret, 1) })).r.status).toBe(200);
  });

  it('signs in with a backup code once and says how many are left', async () => {
    const { u, codes } = await enrolled();
    const ok = await login(u.email, { backupCode: codes[3]!.toUpperCase().replace('-', ' ') });
    expect(ok.r.status).toBe(200);
    expect(ok.r.body.backupCodesLeft).toBe(9);
    expect((await login(u.email, { backupCode: codes[3] })).r.status).toBe(401);
    expect((await h.db.query(`SELECT count(*)::int AS n FROM auth_events WHERE user_id = $1 AND type = 'mfa_backup_code_used'`, [u.id])).rows[0].n).toBe(1);
    expect((await ok.cl.get('/api/v1/auth/mfa')).body.data).toMatchObject({ enabled: true, backupCodesLeft: 9 });
  });

  it("skips the code on a trusted device for 30 days, until it is revoked or the password changes", async () => {
    const { u, secret } = await enrolled();
    const browser = new Client(h.app);
    const first = await login(u.email, { totp: await totpFor(secret), trustDevice: true }, browser);
    expect(first.r.status).toBe(200);
    await browser.post('/api/v1/auth/logout');
    const again = await login(u.email, {}, browser);
    expect(again.r.status).toBe(200);
    expect(again.r.body.user).toBeTruthy();
    // Another browser still needs the code.
    expect((await login(u.email)).r.body.mfaRequired).toBe(true);
    const list = (await browser.get('/api/v1/auth/mfa')).body.data.trustedDevices;
    expect(list).toHaveLength(1);
    expect(list[0].current).toBe(true);
    expect((await browser.del(`/api/v1/auth/mfa/trusted-devices/${list[0].id}`)).status).toBe(200);
    await browser.post('/api/v1/auth/logout');
    expect((await login(u.email, {}, browser)).r.body.mfaRequired).toBe(true);
  });

  it('turns off only after a fresh password and code, and makes new backup codes the same way', async () => {
    const { cl, secret } = await enrolled();
    expect((await cl.post('/api/v1/auth/mfa/backup-codes')).body.error.code).toBe('step_up_required');
    expect((await cl.post('/api/v1/auth/step-up', { password: TEST_PASSWORD, totp: await totpFor(secret, 1) })).status).toBe(200);
    const fresh = await cl.post('/api/v1/auth/mfa/backup-codes');
    expect(fresh.body.backupCodes).toHaveLength(10);
    expect((await cl.post('/api/v1/auth/mfa/disable')).status).toBe(200);
    expect((await cl.get('/api/v1/auth/me')).body.user.mfaEnabled).toBe(false);
  });

  it('when required for everyone, blocks organization pages until it is set up and cannot be turned off', async () => {
    const u = await makeUser(h.db);
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: u.id });
    await setSettings(h.db, 'platform', { requireMfaForAllUsers: true });
    h.app.ctx.settings.invalidate();
    const { cl } = await login(u.email);
    expect((await cl.get('/api/v1/auth/me')).body.user).toMatchObject({ mfaRequired: true, mfaEnabled: false });
    const blocked = await cl.get(`/api/v1/orgs/${org}/campaigns`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('mfa_required');
    const setup = (await cl.post('/api/v1/auth/mfa/setup')).body;
    expect((await cl.post('/api/v1/auth/mfa/enable', { code: await totpFor(setup.secret) })).status).toBe(200);
    expect((await cl.get(`/api/v1/orgs/${org}/campaigns`)).status).toBe(200);
    const off = await cl.post('/api/v1/auth/mfa/disable');
    expect(off.status).toBe(403);
    expect(off.body.error.message).toMatch(/requires two-step/);
  });

  it('lets support reset it for someone who lost their phone, with a reason and a fresh confirmation', async () => {
    const { u, secret } = await enrolled();
    const admin = await makeUser(h.db, { platformRole: 'super_admin' });
    const ad = (await login(admin.email)).cl;
    expect((await ad.post(`/api/v1/admin/users/${u.id}/mfa/reset`, { reason: 'Lost phone, identity checked by email' })).body.error.code).toBe('step_up_required');
    await ad.post('/api/v1/auth/step-up', { password: TEST_PASSWORD });
    expect((await ad.post(`/api/v1/admin/users/${u.id}/mfa/reset`, { reason: 'x' })).status).toBe(400);
    expect((await ad.post(`/api/v1/admin/users/${u.id}/mfa/reset`, { reason: 'Lost phone, identity checked by email' })).status).toBe(200);
    const after = await login(u.email);
    expect(after.r.status).toBe(200);
    expect(after.r.body.user.mfaEnabled).toBe(false);
    expect((await h.db.query('SELECT count(*)::int AS n FROM mfa_backup_codes WHERE user_id = $1', [u.id])).rows[0].n).toBe(0);
    const log = (await h.db.query(`SELECT action, reason FROM audit_logs WHERE action = 'user.mfa_reset' AND resource_id = $1`, [u.id])).rows;
    expect(log).toHaveLength(1);
    void secret;
  });
});
