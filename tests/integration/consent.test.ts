import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyDeliveryToken } from '@blissnova/tracking';
import { BROWSER_UA, createHarness, type Harness } from '../helpers/app';
import { gppString, tcString, usNat } from '../helpers/consent';
import { fundOrg, makeCampaign, makeCreative, makeOrg, makeSite, makeUnit, makeUser, reserve, setSettings, uniq } from '../helpers/fixtures';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ TCF_VENDOR_ID: '1234' });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

const VID = 'visitor-consent-abcdefgh';

async function scenario(personalizedAllowed = true) {
  const adv = await makeOrg(h.db, { type: 'advertiser', ownerId: (await makeUser(h.db)).id });
  const pub = await makeOrg(h.db, { type: 'publisher', ownerId: (await makeUser(h.db)).id });
  const site = await makeSite(h.db, { orgId: pub, domain: 'pub.example.org' });
  const unit = await makeUnit(h.db, { siteId: site.id, formats: ['image'], width: 300, height: 250 });
  await fundOrg(h.db, adv, '500');
  const campaign = await makeCampaign(h.db, { orgId: adv, rate: '2.00', lifetime: '100', daily: null });
  await makeCreative(h.db, { campaignId: campaign, orgId: adv, format: 'image', width: 300, height: 250 });
  await reserve(h.db, campaign);
  await setSettings(h.db, 'tracking', { personalizedAllowed });
  h.app.ctx.settings.invalidate();
  return { site, unit };
}

async function serve(s: Awaited<ReturnType<typeof scenario>>, consent: object | undefined, headers: Record<string, string> = {}) {
  const r = await h.app.inject({
    method: 'POST', url: '/api/v1/serve',
    headers: { 'user-agent': BROWSER_UA, origin: 'http://pub.example.org', ...headers },
    payload: { siteKey: s.site.publicKey, units: [{ slot: s.unit.key }], page: { url: 'http://pub.example.org/a' }, consent, vid: VID, pv: uniq('pv0000000000') },
  });
  expect(r.statusCode).toBe(200);
  const body = JSON.parse(r.body) as { ads: Array<{ ad: { token: string } | null }>; privacy?: { personalization: boolean; reason: string } };
  const token = body.ads[0]?.ad?.token;
  const claims = token ? verifyDeliveryToken(h.app.ctx.tokens, token, Date.now(), 60_000) : null;
  return { privacy: body.privacy, contextual: claims && claims.ok ? claims.claims.ct : undefined, visitor: claims && claims.ok ? claims.claims.v : undefined };
}

describe('consent signals on ad requests', () => {
  it('personalizes with TCF consent for our vendor id and purposes 1, 3 and 4', async () => {
    const s = await scenario();
    const r = await serve(s, { gdprApplies: true, tcString: tcString({ purposes: [1, 3, 4], vendors: [1234] }) });
    expect(r.privacy).toEqual({ personalization: true, reason: 'allowed' });
    expect(r.contextual).toBe(false);
    expect(r.visitor).toBeTruthy();
  });

  it('serves a contextual ad, with no visitor id, when TCF consent is refused', async () => {
    const s = await scenario();
    const r = await serve(s, { gdprApplies: true, tcString: tcString({ purposes: [1], vendors: [] }) });
    expect(r.privacy).toEqual({ personalization: false, reason: 'tcf_denied' });
    expect(r.contextual).toBe(true);
    expect(r.visitor).toBeUndefined();
  });

  it('honours the Sec-GPC header', async () => {
    const s = await scenario();
    const r = await serve(s, { personalized: true }, { 'sec-gpc': '1' });
    expect(r.privacy?.reason).toBe('gpc');
    expect(r.contextual).toBe(true);
  });

  it('honours a US opt-out in a GPP string', async () => {
    const s = await scenario();
    const r = await serve(s, { personalized: true, gpp: gppString([{ id: 7, body: usNat({ sale: 1 }) }]), gppSections: [7] });
    expect(r.privacy?.reason).toBe('gpp_opt_out');
    expect(r.contextual).toBe(true);
  });

  it('stays contextual while the network has personalization off, whatever the page says', async () => {
    const s = await scenario(false);
    const r = await serve(s, { gdprApplies: true, tcString: tcString({ purposes: [1, 3, 4], vendors: [1234] }) });
    expect(r.privacy?.reason).toBe('network_off');
    expect(r.contextual).toBe(true);
  });

  it('rejects oversized or malformed consent strings', async () => {
    const s = await scenario();
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/serve', headers: { 'user-agent': BROWSER_UA, origin: 'http://pub.example.org' },
      payload: { siteKey: s.site.publicKey, units: [{ slot: s.unit.key }], page: { url: 'http://pub.example.org/a' }, consent: { tcString: '<script>' }, pv: uniq('pv0000000000') },
    });
    expect(r.statusCode).toBe(400);
  });
});
