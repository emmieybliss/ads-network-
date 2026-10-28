import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BROWSER_UA, createHarness, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { fundOrg, makeCampaign, makeCreative, makeOrg, makeSite, makeUnit, makeUser, reserve, TEST_PASSWORD, uniq } from '../helpers/fixtures';

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

async function publisher(domain = 'pub.example.org') {
  const u = await makeUser(h.db);
  const org = await makeOrg(h.db, { type: 'publisher', ownerId: u.id });
  const site = await makeSite(h.db, { orgId: org, domain });
  const cl = new Client(h.app);
  await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
  return { org, site, cl };
}

describe('placement types', () => {
  it('creates anchor, rail and interstitial placements and gives each its snippet', async () => {
    const p = await publisher();
    const base = `/api/v1/orgs/${p.org}/sites/${p.site.id}/units`;
    for (const [key, display, w, ht] of [['anchor', 'anchor', 728, 90], ['rail', 'rail_right', 160, 600], ['ist', 'interstitial', null, null]] as const) {
      const r = await p.cl.post(base, { key, name: key, formats: ['image'], width: w, height: ht, responsive: true, display });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.data.display).toBe(display);
    }
    const tag = await p.cl.get(`/api/v1/orgs/${p.org}/sites/${p.site.id}/tag`);
    const byKey = new Map(tag.body.data.units.map((u: any) => [u.key, u]));
    expect((byKey.get('anchor') as any).snippet).toContain('data-bn-display="anchor"');
    expect((byKey.get('rail') as any).snippet).toContain('data-bn-display="rail_right"');
    expect((byKey.get('ist') as any).snippet).toContain('data-bn-display="interstitial"');
  });

  it('reserves space for inline slots, and can keep it when no ad fills', async () => {
    const p = await publisher();
    const base = `/api/v1/orgs/${p.org}/sites/${p.site.id}/units`;
    await p.cl.post(base, { key: 'fixed', name: 'Fixed', formats: ['image'], width: 300, height: 250, responsive: false });
    await p.cl.post(base, { key: 'flex', name: 'Flex', formats: ['image'], width: 728, height: 90, responsive: true, noFill: 'keep_space' });
    const tag = await p.cl.get(`/api/v1/orgs/${p.org}/sites/${p.site.id}/tag`);
    const byKey = new Map(tag.body.data.units.map((u: any) => [u.key, u.snippet as string]));
    expect(byKey.get('fixed')).toContain('style="width:300px;max-width:100%;aspect-ratio:300/250"');
    expect(byKey.get('flex')).toContain('style="min-height:min(90px, 12.36vw)"');
    expect(byKey.get('flex')).toContain('data-bn-keep-space');
    expect(byKey.get('fixed')).not.toContain('data-bn-keep-space');
  });

  it('limits anchors to 120 px tall and rails to 300 px wide', async () => {
    const p = await publisher();
    const base = `/api/v1/orgs/${p.org}/sites/${p.site.id}/units`;
    expect((await p.cl.post(base, { key: 'tall', name: 'Tall', formats: ['image'], width: 300, height: 250, display: 'anchor' })).status).toBe(400);
    expect((await p.cl.post(base, { key: 'wide', name: 'Wide', formats: ['image'], width: 728, height: 90, display: 'rail_left' })).status).toBe(400);
    const ok = await p.cl.post(base, { key: 'ok', name: 'Ok', formats: ['image'], width: 320, height: 50, display: 'anchor' });
    expect(ok.status).toBe(201);
    // Changing an existing placement is held to the same rule.
    expect((await p.cl.patch(`/api/v1/orgs/${p.org}/units/${ok.body.data.id}`, { width: 300, height: 250 })).status).toBe(400);
  });

  it('keeps every field a PATCH leaves out', async () => {
    const p = await publisher();
    const made = await p.cl.post(`/api/v1/orgs/${p.org}/sites/${p.site.id}/units`, { key: 'keep', name: 'Keep', formats: ['image'], width: 160, height: 600, responsive: false, display: 'rail_left', noFill: 'keep_space' });
    const r = await p.cl.patch(`/api/v1/orgs/${p.org}/units/${made.body.data.id}`, { name: 'Renamed' });
    expect(r.body.data).toMatchObject({ name: 'Renamed', display: 'rail_left', noFill: 'keep_space', responsive: false, width: 160, height: 600 });
  });

  it('tells the ad tag how to show each placement', async () => {
    const adv = await makeOrg(h.db, { type: 'advertiser', ownerId: (await makeUser(h.db)).id });
    const pub = await makeOrg(h.db, { type: 'publisher', ownerId: (await makeUser(h.db)).id });
    const site = await makeSite(h.db, { orgId: pub, domain: 'pub.example.org' });
    const unit = await makeUnit(h.db, { siteId: site.id, formats: ['image'], width: 728, height: 90, responsive: false });
    await h.db.query(`UPDATE ad_units SET display = 'anchor' WHERE id = $1`, [unit.id]);
    await fundOrg(h.db, adv, '100');
    const campaign = await makeCampaign(h.db, { orgId: adv, rate: '2.00', lifetime: '50', daily: null });
    await makeCreative(h.db, { campaignId: campaign, orgId: adv, format: 'image', width: 728, height: 90 });
    await reserve(h.db, campaign);
    h.app.ctx.settings.invalidate();
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/serve', headers: { 'user-agent': BROWSER_UA, origin: 'http://pub.example.org' },
      payload: { siteKey: site.publicKey, units: [{ slot: unit.key }], page: { url: 'http://pub.example.org/a' }, pv: uniq('pv0000000000') },
    });
    const body = JSON.parse(r.body);
    expect(body.ads[0].display).toBe('anchor');
    expect(body.ads[0].ad).not.toBeNull();
  });
});

describe('automatic in-article ads', () => {
  it('saves the settings and serves them to the ad tag', async () => {
    const p = await publisher();
    const unit = (await p.cl.post(`/api/v1/orgs/${p.org}/sites/${p.site.id}/units`, { key: 'auto', name: 'Auto', formats: ['image'], width: 300, height: 250, responsive: true })).body.data;
    const url = `/api/v1/orgs/${p.org}/sites/${p.site.id}/auto-ads`;
    expect((await h.app.inject({ method: 'GET', url: `/api/v1/public/sites/${p.site.publicKey}/auto` })).json()).toEqual({ enabled: false });

    const r = await p.cl.put(url, { enabled: true, unitId: unit.id, maxAds: 2, spacing: 3, firstAfter: 2, selector: '.post-body' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.loader).toContain('data-auto="1"');

    const pub = await h.app.inject({ method: 'GET', url: `/api/v1/public/sites/${p.site.publicKey}/auto` });
    expect(pub.headers['cache-control']).toContain('max-age=300');
    expect(pub.json()).toEqual({ enabled: true, slot: 'auto', maxAds: 2, spacing: 3, firstAfter: 2, selector: '.post-body', width: 300, height: 250 });

    // Pausing the placement switches automatic ads off for the tag.
    await p.cl.post(`/api/v1/orgs/${p.org}/units/${unit.id}/pause`);
    expect((await h.app.inject({ method: 'GET', url: `/api/v1/public/sites/${p.site.publicKey}/auto` })).json()).toEqual({ enabled: false });
  });

  it('needs an in-page placement from the same site, within the limits', async () => {
    const p = await publisher();
    const other = await publisher('other.example.org');
    const base = `/api/v1/orgs/${p.org}/sites/${p.site.id}`;
    const anchor = (await p.cl.post(`${base}/units`, { key: 'anc', name: 'Anc', formats: ['image'], width: 320, height: 50, display: 'anchor' })).body.data;
    const fr = await other.cl.post(`/api/v1/orgs/${other.org}/sites/${other.site.id}/units`, { key: 'xx', name: 'X', formats: ['image'], width: 300, height: 250 });
    expect(fr.status, JSON.stringify(fr.body)).toBe(201);
    const foreign = fr.body.data;
    const body = { enabled: true, maxAds: 3, spacing: 4, firstAfter: 3 };
    expect((await p.cl.put(`${base}/auto-ads`, { ...body, unitId: null })).status).toBe(400);
    expect((await p.cl.put(`${base}/auto-ads`, { ...body, unitId: anchor.id })).status).toBe(400);
    expect((await p.cl.put(`${base}/auto-ads`, { ...body, unitId: foreign.id })).status).toBe(400);
    const inline = (await p.cl.post(`${base}/units`, { key: 'in', name: 'In', formats: ['image'], width: 300, height: 250 })).body.data;
    expect((await p.cl.put(`${base}/auto-ads`, { ...body, unitId: inline.id, maxAds: 9 })).status).toBe(400);
    expect((await p.cl.put(`${base}/auto-ads`, { ...body, unitId: inline.id })).status).toBe(200);
    // Another publisher cannot read or change it.
    expect([403, 404]).toContain((await other.cl.put(`${base}/auto-ads`, { ...body, unitId: inline.id })).status);
  });
});
