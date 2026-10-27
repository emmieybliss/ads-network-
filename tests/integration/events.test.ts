import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BROWSER_UA, createHarness, type Harness } from '../helpers/app';
import { fundOrg, makeCampaign, makeCreative, makeOrg, makeSite, makeUnit, makeUser, reserve, setSettings, uniq } from '../helpers/fixtures';

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

async function setup(opts: { model?: 'cpm' | 'cpc'; rate?: string; lifetime?: string; revenueShareBps?: number } = {}) {
  const advUser = await makeUser(h.db);
  const pubUser = await makeUser(h.db);
  const advOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: advUser.id });
  const pubOrg = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id, revenueShareBps: opts.revenueShareBps ?? 7000 });
  const site = await makeSite(h.db, { orgId: pubOrg, domain: 'pub.example.org' });
  const unit = await makeUnit(h.db, { siteId: site.id, formats: ['image'], width: 300, height: 250 });
  await fundOrg(h.db, advOrg, '5000');
  const campaign = await makeCampaign(h.db, { orgId: advOrg, model: opts.model ?? 'cpm', rate: opts.rate ?? '2.00', lifetime: opts.lifetime ?? '1000', daily: null });
  await makeCreative(h.db, { campaignId: campaign, orgId: advOrg, format: 'image', width: 300, height: 250 });
  await reserve(h.db, campaign);
  if ((opts.model ?? 'cpm') === 'cpc') await setSettings(h.db, 'pricing', { cpcEnabled: true });
  h.app.ctx.settings.invalidate();
  const { invalidateServingCache } = await import('@blissnova/api/services/serving');
  invalidateServingCache(h.app.ctx);
  return { advOrg, pubOrg, site, unit, campaign };
}

async function getAd(siteKey: string, slot: string) {
  const r = await h.app.inject({
    method: 'POST',
    url: '/api/v1/serve',
    headers: { 'user-agent': BROWSER_UA, origin: 'http://pub.example.org' },
    payload: { siteKey, units: [{ slot }], page: { url: 'http://pub.example.org/article' }, pv: uniq('pv0000000000') },
  });
  const body = JSON.parse(r.body) as { ads: Array<{ ad: { token: string; clickUrl: string } | null }> };
  const ad = body.ads[0]!.ad;
  if (!ad) throw new Error('no ad was served');
  return ad;
}

async function sendEvents(events: Array<{ id?: string; type: 'render' | 'viewable'; t: string }>, headers: Record<string, string> = {}) {
  const r = await h.app.inject({
    method: 'POST',
    url: '/api/v1/events',
    headers: { 'user-agent': BROWSER_UA, referer: 'http://pub.example.org/article', origin: 'http://pub.example.org', ...headers },
    payload: { events: events.map((e) => ({ id: e.id ?? uniq('ev0000000000'), type: e.type, t: e.t })) },
  });
  return { status: r.statusCode, body: JSON.parse(r.body) as { accepted: number; results?: unknown[] } };
}

async function clickThrough(clickUrl: string, headers: Record<string, string> = {}) {
  const url = clickUrl.slice(clickUrl.indexOf('/api/v1/click'));
  return h.app.inject({ method: 'GET', url, headers: { 'user-agent': BROWSER_UA, referer: 'http://pub.example.org/article', ...headers } });
}

const eventRows = () =>
  h.db.query<{ type: string; status: string; invalid_reason: string | null; billable: boolean; cost_micros: string; publisher_micros: string }>(
    'SELECT type, status, invalid_reason, billable, cost_micros, publisher_micros FROM ad_events ORDER BY occurred_at, type',
  );

const campaignRow = (id: string) =>
  h.db
    .query<{ spent_micros: string; billable_impressions: string; billable_clicks: string }>(
      'SELECT spent_micros, billable_impressions, billable_clicks FROM campaigns WHERE id = $1',
      [id],
    )
    .then((r) => r.rows[0]!);

describe('impression tracking', () => {
  it('charges a CPM campaign a thousandth of its rate for a valid render', async () => {
    const s = await setup({ model: 'cpm', rate: '2.50' });
    const ad = await getAd(s.site.publicKey, s.unit.key);
    const r = await sendEvents([{ type: 'render', t: ad.token }]);
    expect(r.status).toBe(202);
    expect(r.body.accepted).toBe(1);

    const camp = await campaignRow(s.campaign);
    expect(camp.spent_micros).toBe('2500'); // $2.50 CPM / 1000
    expect(camp.billable_impressions).toBe('1');
    expect(camp.billable_clicks).toBe('0');
  });

  it('gives the publisher their revenue share of the charge', async () => {
    const s = await setup({ model: 'cpm', rate: '10.00', revenueShareBps: 6500 });
    const ad = await getAd(s.site.publicKey, s.unit.key);
    await sendEvents([{ type: 'render', t: ad.token }]);
    const rows = await eventRows();
    const render = rows.rows.find((r) => r.type === 'render')!;
    expect(render.cost_micros).toBe('10000'); // $10 CPM / 1000
    expect(render.publisher_micros).toBe('6500'); // 65%
  });

  it('records a viewable impression without charging twice', async () => {
    const s = await setup();
    const ad = await getAd(s.site.publicKey, s.unit.key);
    await sendEvents([{ type: 'render', t: ad.token }]);
    const before = await campaignRow(s.campaign);
    await sendEvents([{ type: 'viewable', t: ad.token }]);
    const after = await campaignRow(s.campaign);
    expect(after.spent_micros).toBe(before.spent_micros);
    const rows = await eventRows();
    expect(rows.rows.map((r) => r.type).sort()).toEqual(['render', 'served', 'viewable']);
  });

  it('does not charge a CPM campaign for a click', async () => {
    const s = await setup({ model: 'cpm', rate: '2.00' });
    const ad = await getAd(s.site.publicKey, s.unit.key);
    await sendEvents([{ type: 'render', t: ad.token }]);
    const before = await campaignRow(s.campaign);
    await clickThrough(ad.clickUrl);
    const after = await campaignRow(s.campaign);
    expect(after.spent_micros).toBe(before.spent_micros);
    expect(after.billable_clicks).toBe('0');
  });

  it('accepts a batch sent as text/plain, the way sendBeacon does', async () => {
    const s = await setup();
    const a = await getAd(s.site.publicKey, s.unit.key);
    const b = await getAd(s.site.publicKey, s.unit.key);
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { 'user-agent': BROWSER_UA, 'content-type': 'text/plain;charset=UTF-8', referer: 'http://pub.example.org/a' },
      payload: JSON.stringify({
        events: [
          { id: uniq('ev0000000000'), type: 'render', t: a.token },
          { id: uniq('ev0000000000'), type: 'render', t: b.token },
        ],
      }),
    });
    expect(r.statusCode).toBe(202);
    expect(JSON.parse(r.body).accepted).toBe(2);
  });
});

describe('deduplication', () => {
  it('ignores a retry of the same client event id without charging again', async () => {
    const s = await setup();
    const ad = await getAd(s.site.publicKey, s.unit.key);
    const id = uniq('ev0000000000');
    const first = await sendEvents([{ id, type: 'render', t: ad.token }]);
    const retry = await sendEvents([{ id, type: 'render', t: ad.token }]);
    expect(first.body.accepted).toBe(1);
    expect(retry.body.accepted).toBe(0);
    expect((await campaignRow(s.campaign)).billable_impressions).toBe('1');
  });

  it('marks a second render of the same delivery invalid rather than charging twice', async () => {
    const s = await setup();
    const ad = await getAd(s.site.publicKey, s.unit.key);
    await sendEvents([{ type: 'render', t: ad.token }]);
    await sendEvents([{ type: 'render', t: ad.token }]); // new client id, same token
    const rows = await eventRows();
    const renders = rows.rows.filter((r) => r.type === 'render');
    expect(renders).toHaveLength(2);
    expect(renders.filter((r) => r.billable)).toHaveLength(1);
    expect(renders.find((r) => !r.billable)!.invalid_reason).toBe('duplicate');
    expect((await campaignRow(s.campaign)).billable_impressions).toBe('1');
  });

  it('charges once when the same render arrives many times at once', async () => {
    const s = await setup();
    const ad = await getAd(s.site.publicKey, s.unit.key);
    await Promise.all(Array.from({ length: 10 }, () => sendEvents([{ type: 'render', t: ad.token }])));
    expect((await campaignRow(s.campaign)).billable_impressions).toBe('1');
  });
});

describe('invalid traffic', () => {
  it('rejects an event with a forged token', async () => {
    await setup();
    const r = await sendEvents([{ type: 'render', t: 'k1.' + Buffer.from('x'.repeat(40)).toString('base64url') }]);
    expect(r.body.accepted).toBe(0);
    expect((await eventRows()).rows.filter((x) => x.type === 'render')).toHaveLength(0);
  });

  it('rejects an event reported from a domain the site has not registered', async () => {
    const s = await setup();
    const ad = await getAd(s.site.publicKey, s.unit.key);
    await sendEvents([{ type: 'render', t: ad.token }], { referer: 'http://attacker.example.net/page', origin: 'http://attacker.example.net' });
    const rows = await eventRows();
    const render = rows.rows.find((r) => r.type === 'render');
    expect(render?.status).toBe('invalid');
    expect(render?.invalid_reason).toBe('domain_mismatch');
    expect((await campaignRow(s.campaign)).spent_micros).toBe('0');
  });

  it('rejects an event reported by a crawler', async () => {
    const s = await setup();
    const ad = await getAd(s.site.publicKey, s.unit.key);
    await sendEvents([{ type: 'render', t: ad.token }], { 'user-agent': 'Googlebot/2.1' });
    const render = (await eventRows()).rows.find((r) => r.type === 'render');
    expect(render?.status).toBe('invalid');
    expect(render?.invalid_reason).toBe('crawler');
  });

  it('rejects a viewable impression that never had a render', async () => {
    const s = await setup();
    const ad = await getAd(s.site.publicKey, s.unit.key);
    await sendEvents([{ type: 'viewable', t: ad.token }]);
    const v = (await eventRows()).rows.find((r) => r.type === 'viewable');
    expect(v?.status).toBe('invalid');
    expect(v?.invalid_reason).toBe('sequence');
  });

  it('records an invalid event instead of silently dropping it, so it can be audited', async () => {
    const s = await setup();
    const ad = await getAd(s.site.publicKey, s.unit.key);
    await sendEvents([{ type: 'render', t: ad.token }], { 'user-agent': 'curl/8.4.0' });
    const rows = await eventRows();
    expect(rows.rows.some((r) => r.type === 'render' && r.status === 'invalid')).toBe(true);
  });
});

describe('click tracking', () => {
  it('charges a CPC campaign its full rate for a valid click', async () => {
    const s = await setup({ model: 'cpc', rate: '0.18' });
    const ad = await getAd(s.site.publicKey, s.unit.key);
    await sendEvents([{ type: 'render', t: ad.token }]);
    // The platform requires a minimum delay between render and click.
    await new Promise((r) => setTimeout(r, 350));
    const res = await clickThrough(ad.clickUrl);
    expect(res.statusCode).toBe(302);
    const camp = await campaignRow(s.campaign);
    expect(camp.spent_micros).toBe('180000');
    expect(camp.billable_clicks).toBe('1');
  });

  it('redirects only to the destination stored for the creative', async () => {
    const s = await setup({ model: 'cpc', rate: '0.10' });
    await h.db.query(`UPDATE creatives SET destination_url = 'https://example.com/real-landing'`);
    await h.db.query(`UPDATE creative_versions SET snapshot = jsonb_set(snapshot, '{destinationUrl}', '"https://example.com/real-landing"')`);
    const ad = await getAd(s.site.publicKey, s.unit.key);
    const res = await clickThrough(ad.clickUrl);
    expect(res.headers.location).toBe('https://example.com/real-landing');
  });

  it('ignores a destination supplied by the caller', async () => {
    const s = await setup({ model: 'cpc', rate: '0.10' });
    const ad = await getAd(s.site.publicKey, s.unit.key);
    const url = ad.clickUrl.slice(ad.clickUrl.indexOf('/api/v1/click'));
    const res = await h.app.inject({ method: 'GET', url: `${url}&url=https://evil.example.net`, headers: { 'user-agent': BROWSER_UA } });
    expect(String(res.headers.location ?? '')).not.toContain('evil.example.net');
  });

  it('does not leak the publisher page in the referrer when it redirects', async () => {
    const s = await setup({ model: 'cpc', rate: '0.10' });
    const ad = await getAd(s.site.publicKey, s.unit.key);
    const res = await clickThrough(ad.clickUrl);
    expect(String(res.headers['referrer-policy'])).toBe('no-referrer');
  });

  it('charges at most one click per delivery', async () => {
    const s = await setup({ model: 'cpc', rate: '0.25' });
    const ad = await getAd(s.site.publicKey, s.unit.key);
    await sendEvents([{ type: 'render', t: ad.token }]);
    await new Promise((r) => setTimeout(r, 350));
    await clickThrough(ad.clickUrl);
    await new Promise((r) => setTimeout(r, 1100)); // past the per-second dedupe key
    await clickThrough(ad.clickUrl);
    const camp = await campaignRow(s.campaign);
    expect(camp.billable_clicks).toBe('1');
    expect(camp.spent_micros).toBe('250000');
  });

  it('shows a plain page rather than an error for an unreadable token', async () => {
    await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/click?t=' + 'x'.repeat(40), headers: { 'user-agent': BROWSER_UA } });
    expect(res.statusCode).toBe(400);
    expect(String(res.headers['content-type'])).toContain('text/html');
    expect(res.body).not.toContain('stack');
  });
});

describe('budget enforcement under concurrency', () => {
  it('never charges past the lifetime budget when renders arrive together', async () => {
    // Budget for exactly 5 impressions: $1,000 CPM is $1 each, budget $5.
    const s = await setup({ model: 'cpm', rate: '1000', lifetime: '5' });
    const ads = [];
    for (let i = 0; i < 20; i++) ads.push(await getAd(s.site.publicKey, s.unit.key));

    await Promise.all(ads.map((ad) => sendEvents([{ type: 'render', t: ad.token }])));

    const camp = await campaignRow(s.campaign);
    expect(BigInt(camp.spent_micros)).toBeLessThanOrEqual(5_000_000n);
    expect(Number(camp.billable_impressions)).toBeLessThanOrEqual(5);
    // And it must actually have spent the budget, not stopped early.
    expect(camp.spent_micros).toBe('5000000');
    expect(camp.billable_impressions).toBe('5');

    // Impressions past the budget are recorded as valid but not billable: the
    // publisher served them, the advertiser is not charged for them.
    const rows = await eventRows();
    const renders = rows.rows.filter((r) => r.type === 'render');
    expect(renders.filter((r) => r.billable)).toHaveLength(5);
    expect(renders.filter((r) => r.status === 'valid' && !r.billable).length).toBeGreaterThan(0);
  });

  it('keeps spend within the daily budget', async () => {
    const advUser = await makeUser(h.db);
    const pubUser = await makeUser(h.db);
    const advOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: advUser.id });
    const pubOrg = await makeOrg(h.db, { type: 'publisher', ownerId: pubUser.id });
    const site = await makeSite(h.db, { orgId: pubOrg, domain: 'pub.example.org' });
    const unit = await makeUnit(h.db, { siteId: site.id, formats: ['image'] });
    await fundOrg(h.db, advOrg, '1000');
    // $1 per impression, $100 lifetime, $3 a day.
    const campaign = await makeCampaign(h.db, { orgId: advOrg, rate: '1000', lifetime: '100', daily: '3', pacing: 'asap' });
    await makeCreative(h.db, { campaignId: campaign, orgId: advOrg, format: 'image' });
    await reserve(h.db, campaign);
    const { invalidateServingCache } = await import('@blissnova/api/services/serving');
    invalidateServingCache(h.app.ctx);

    const ads = [];
    for (let i = 0; i < 10; i++) {
      try {
        ads.push(await getAd(site.publicKey, unit.key));
      } catch {
        break; // the serving layer stopped filling: that is the point
      }
    }
    await Promise.all(ads.map((ad) => sendEvents([{ type: 'render', t: ad.token }])));

    const daily = await h.db.query<{ spent_micros: string }>('SELECT spent_micros FROM campaign_daily_spend WHERE campaign_id = $1', [campaign]);
    expect(BigInt(daily.rows[0]?.spent_micros ?? '0')).toBeLessThanOrEqual(3_000_000n);
  });

  it('keeps the ledger balanced after concurrent charges', async () => {
    const s = await setup({ model: 'cpm', rate: '1000', lifetime: '5' });
    const ads = [];
    for (let i = 0; i < 12; i++) ads.push(await getAd(s.site.publicKey, s.unit.key));
    await Promise.all(ads.map((ad) => sendEvents([{ type: 'render', t: ad.token }])));

    const unbalanced = await h.db.query(
      'SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount_micros) <> 0',
    );
    expect(unbalanced.rowCount).toBe(0);
  });
});
