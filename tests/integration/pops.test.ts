import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BROWSER_UA, createHarness, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { fundOrg, makeCampaign, makeCreative, makeOrg, makeSite, makeUser, reserve, setSettings, TEST_PASSWORD, uniq } from '../helpers/fixtures';

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

async function signedIn() {
  const u = await makeUser(h.db);
  const cl = new Client(h.app);
  await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
  return { user: u, cl };
}

async function publisher() {
  const s = await signedIn();
  const org = await makeOrg(h.db, { type: 'publisher', ownerId: s.user.id });
  const site = await makeSite(h.db, { orgId: org, domain: 'pub.example.org', formats: ['image', 'text', 'native', 'pop'] });
  return { org, site, cl: s.cl };
}

async function popCampaign(model: 'cpm' | 'cpc' = 'cpm') {
  const adv = await makeOrg(h.db, { type: 'advertiser', ownerId: (await makeUser(h.db)).id });
  await fundOrg(h.db, adv, '100');
  const campaign = await makeCampaign(h.db, { orgId: adv, model, rate: model === 'cpm' ? '2.00' : '0.20', lifetime: '50', daily: null });
  await makeCreative(h.db, { campaignId: campaign, orgId: adv, format: 'pop', destination: 'https://example.com/offer' });
  await reserve(h.db, campaign);
  return campaign;
}

const serve = (siteKey: string, slot: string, ip = '203.0.113.7') => h.app.inject({
  method: 'POST', url: '/api/v1/serve', remoteAddress: ip, headers: { 'user-agent': BROWSER_UA, origin: 'http://pub.example.org' },
  payload: { siteKey, units: [{ slot }], page: { url: 'http://pub.example.org/a' }, pv: uniq('pv0000000000') },
}).then((r) => JSON.parse(r.body));

function refresh() {
  h.app.ctx.settings.invalidate();
}

describe('pop-up and pop-under placements', () => {
  it('creates pop placements that only take pop ads, with their own limits', async () => {
    const p = await publisher();
    const base = `/api/v1/orgs/${p.org}/sites/${p.site.id}/units`;
    const r = await p.cl.post(base, { key: 'pu', name: 'Pop-under', formats: ['image'], width: 300, height: 250, display: 'popunder', popMaxPerDay: 2, popMinutesBetween: 30 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ display: 'popunder', formats: ['pop'], width: null, height: null, popMaxPerDay: 2, popMinutesBetween: 30 });
    const tag = await p.cl.get(`/api/v1/orgs/${p.org}/sites/${p.site.id}/tag`);
    expect(tag.body.data.units[0].snippet).toContain('data-bn-display="popunder"');

    // An in-page placement never takes pop ads.
    expect((await p.cl.post(base, { key: 'inl', name: 'Inline', formats: ['pop'], display: 'inline' })).status).toBe(400);
    // Turning a pop placement back into an in-page one needs its formats.
    expect((await p.cl.patch(`/api/v1/orgs/${p.org}/units/${r.body.data.id}`, { display: 'inline' })).status).toBe(400);
    const back = await p.cl.patch(`/api/v1/orgs/${p.org}/units/${r.body.data.id}`, { display: 'inline', formats: ['text'] });
    expect(back.body.data).toMatchObject({ display: 'inline', formats: ['text'] });
  });

  it('refuses new pop placements when the network has them turned off', async () => {
    const p = await publisher();
    const base = `/api/v1/orgs/${p.org}/sites/${p.site.id}/units`;
    await setSettings(h.db, 'popAds', { popunderEnabled: false });
    refresh();
    expect((await p.cl.post(base, { key: 'pu', name: 'Under', display: 'popunder' })).status).toBe(400);
    expect((await p.cl.post(base, { key: 'pp', name: 'Up', display: 'popup' })).status).toBe(201);
    await setSettings(h.db, 'popAds', { enabled: false });
    refresh();
    expect((await p.cl.post(base, { key: 'pp2', name: 'Up 2', display: 'popup' })).status).toBe(400);
  });

  it('serves a pop as a landing page, capped per visitor, and stops when the network turns pops off', async () => {
    const p = await publisher();
    const unit = (await p.cl.post(`/api/v1/orgs/${p.org}/sites/${p.site.id}/units`, { key: 'pu', name: 'Pop', display: 'popunder', popMaxPerDay: 5, popMinutesBetween: 1 })).body.data;
    await popCampaign('cpm');
    refresh();

    const first = await serve(p.site.publicKey, unit.key);
    expect(first.ads[0].display).toBe('popunder');
    expect(first.ads[0].ad).toMatchObject({ format: 'pop', pop: { url: 'https://example.com/offer' } });
    // The network's minimum gap (15 minutes by default) is longer than the placement's 1 minute, so it wins.
    expect((await serve(p.site.publicKey, unit.key)).ads[0].ad).toBeNull();
    // Another visitor is not affected.
    expect((await serve(p.site.publicKey, unit.key, '198.51.100.9')).ads[0].ad).not.toBeNull();

    await setSettings(h.db, 'popAds', { enabled: false });
    refresh();
    expect((await serve(p.site.publicKey, unit.key, '192.0.2.44')).ads[0].ad).toBeNull();
  });

  it('never fills a pop with a CPC campaign or an in-page slot with a pop', async () => {
    const p = await publisher();
    const base = `/api/v1/orgs/${p.org}/sites/${p.site.id}/units`;
    const popUnit = (await p.cl.post(base, { key: 'pu', name: 'Pop', display: 'popup' })).body.data;
    const inline = (await p.cl.post(base, { key: 'txt', name: 'Text', formats: ['text'], display: 'inline' })).body.data;
    await popCampaign('cpc');
    refresh();
    expect((await serve(p.site.publicKey, popUnit.key)).ads[0].ad).toBeNull();
    await popCampaign('cpm');
    refresh();
    expect((await serve(p.site.publicKey, inline.key, '198.51.100.20')).ads[0].ad).toBeNull();
  });

  it('only lets advertisers add pop ads to CPM or flat-rate campaigns', async () => {
    const s = await signedIn();
    const adv = await makeOrg(h.db, { type: 'advertiser', ownerId: s.user.id });
    const cpc = await makeCampaign(h.db, { orgId: adv, model: 'cpc', rate: '0.20', status: 'draft' });
    const cpm = await makeCampaign(h.db, { orgId: adv, model: 'cpm', rate: '2.00', status: 'draft' });
    const body = { name: 'Landing', format: 'pop', destinationUrl: 'https://example.com/offer' };
    expect((await s.cl.post(`/api/v1/orgs/${adv}/campaigns/${cpc}/creatives`, body)).status).toBe(400);
    const ok = await s.cl.post(`/api/v1/orgs/${adv}/campaigns/${cpm}/creatives`, body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.format).toBe('pop');
    // And the campaign cannot then switch to CPC.
    expect((await s.cl.patch(`/api/v1/orgs/${adv}/campaigns/${cpm}`, { pricingModel: 'cpc', rate: '0.20' })).status).toBe(409);
  });
});
