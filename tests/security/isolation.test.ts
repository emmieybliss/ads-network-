import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/app';
import { Client } from '../helpers/client';
import { addMember, makeCampaign, makeCreative, makeOrg, makeSite, makeUnit, makeUser, TEST_PASSWORD } from '../helpers/fixtures';

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

async function signedIn(email?: string, opts: Parameters<typeof makeUser>[1] = {}) {
  const u = await makeUser(h.db, { email, ...opts });
  const cl = new Client(h.app);
  const r = await cl.post('/api/v1/auth/login', { email: u.email, password: TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { user: u, cl };
}

/** Confirms the password so step-up-protected admin actions are allowed. */
async function stepUp(cl: Client) {
  const r = await cl.post('/api/v1/auth/step-up', { password: TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`step-up failed: ${r.status} ${JSON.stringify(r.body)}`);
}

describe('organisation isolation', () => {
  it('answers 404, not 403, for an organisation the user is not a member of', async () => {
    // 403 would confirm the organisation exists. 404 tells an attacker nothing.
    const a = await signedIn();
    const b = await signedIn();
    const theirOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: b.user.id });

    const r = await a.cl.get(`/api/v1/orgs/${theirOrg}`);
    expect(r.status).toBe(404);
  });

  it('gives the same 404 for an organisation that does not exist at all', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const theirOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: b.user.id });

    const foreign = await a.cl.get(`/api/v1/orgs/${theirOrg}`);
    const missing = await a.cl.get('/api/v1/orgs/00000000-0000-4000-8000-000000000000');
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body?.error?.code).toBe(missing.body?.error?.code);
  });

  it('will not list, read or change another advertiser\'s campaigns', async () => {
    const victim = await signedIn();
    const victimOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: victim.user.id });
    const campaign = await makeCampaign(h.db, { orgId: victimOrg });

    const attacker = await signedIn();
    const attackerOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: attacker.user.id });

    // Through the victim's organisation id.
    expect((await attacker.cl.get(`/api/v1/orgs/${victimOrg}/campaigns`)).status).toBe(404);
    expect((await attacker.cl.get(`/api/v1/orgs/${victimOrg}/campaigns/${campaign}`)).status).toBe(404);
    expect((await attacker.cl.patch(`/api/v1/orgs/${victimOrg}/campaigns/${campaign}`, { name: 'Taken over' })).status).toBe(404);

    // And through their own organisation id with the victim's campaign id, in
    // case the handler trusts the id in the path over the ownership check.
    expect((await attacker.cl.get(`/api/v1/orgs/${attackerOrg}/campaigns/${campaign}`)).status).toBe(404);
    expect((await attacker.cl.patch(`/api/v1/orgs/${attackerOrg}/campaigns/${campaign}`, { name: 'Taken over' })).status).toBe(404);

    const after = await h.db.query<{ name: string }>('SELECT name FROM campaigns WHERE id = $1', [campaign]);
    expect(after.rows[0]!.name).not.toBe('Taken over');
  });

  it('will not read another advertiser\'s creatives', async () => {
    const victim = await signedIn();
    const victimOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: victim.user.id });
    const campaign = await makeCampaign(h.db, { orgId: victimOrg });
    const creative = await makeCreative(h.db, { campaignId: campaign, orgId: victimOrg });

    const attacker = await signedIn();
    const attackerOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: attacker.user.id });
    expect((await attacker.cl.get(`/api/v1/orgs/${attackerOrg}/creatives/${creative}`)).status).toBe(404);
  });

  it('will not read or change another publisher\'s sites and units', async () => {
    const victim = await signedIn();
    const victimOrg = await makeOrg(h.db, { type: 'publisher', ownerId: victim.user.id });
    const site = await makeSite(h.db, { orgId: victimOrg });
    const unit = await makeUnit(h.db, { siteId: site.id });

    const attacker = await signedIn();
    const attackerOrg = await makeOrg(h.db, { type: 'publisher', ownerId: attacker.user.id });
    expect((await attacker.cl.get(`/api/v1/orgs/${victimOrg}/sites`)).status).toBe(404);
    expect((await attacker.cl.get(`/api/v1/orgs/${attackerOrg}/sites/${site.id}`)).status).toBe(404);
    expect((await attacker.cl.patch(`/api/v1/orgs/${attackerOrg}/units/${unit.id}`, { name: 'Hijacked' })).status).toBe(404);
  });

  it('will not expose another organisation\'s billing or earnings', async () => {
    const victim = await signedIn();
    const victimAdv = await makeOrg(h.db, { type: 'advertiser', ownerId: victim.user.id });
    const victimPub = await makeOrg(h.db, { type: 'publisher', ownerId: victim.user.id });

    const attacker = await signedIn();
    expect((await attacker.cl.get(`/api/v1/orgs/${victimAdv}/billing`)).status).toBe(404);
    expect((await attacker.cl.get(`/api/v1/orgs/${victimAdv}/ledger`)).status).toBe(404);
    expect((await attacker.cl.get(`/api/v1/orgs/${victimPub}/earnings`)).status).toBe(404);
    expect((await attacker.cl.get(`/api/v1/orgs/${victimPub}/payouts`)).status).toBe(404);
  });

  it('will not let an advertiser organisation use publisher endpoints, or the reverse', async () => {
    const u = await signedIn();
    const advOrg = await makeOrg(h.db, { type: 'advertiser', ownerId: u.user.id });
    const pubOrg = await makeOrg(h.db, { type: 'publisher', ownerId: u.user.id });

    // The user is a member of both, so this is about the endpoint's own type
    // requirement, not about membership.
    const siteOnAdvertiser = await u.cl.get(`/api/v1/orgs/${advOrg}/sites`);
    expect(siteOnAdvertiser.status).toBeGreaterThanOrEqual(400);
    const campaignOnPublisher = await u.cl.get(`/api/v1/orgs/${pubOrg}/campaigns`);
    expect(campaignOnPublisher.status).toBeGreaterThanOrEqual(400);
  });

  it('removing a member immediately ends their access', async () => {
    const owner = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: owner.user.id });
    const member = await signedIn();
    await addMember(h.db, org, member.user.id, 'manager');

    expect((await member.cl.get(`/api/v1/orgs/${org}`)).status).toBe(200);
    const removed = await owner.cl.del(`/api/v1/orgs/${org}/members/${member.user.id}`);
    expect(removed.status).toBeLessThan(300);
    expect((await member.cl.get(`/api/v1/orgs/${org}`)).status).toBe(404);
  });
});

describe('role enforcement inside an organisation', () => {
  it('stops an analyst from creating a campaign', async () => {
    const owner = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: owner.user.id });
    const analyst = await signedIn();
    await addMember(h.db, org, analyst.user.id, 'analyst');

    const r = await analyst.cl.post(`/api/v1/orgs/${org}/campaigns`, {
      name: 'Analyst campaign',
      pricingModel: 'cpm',
      rate: '2.00',
      lifetimeBudget: '100',
      startAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    expect(r.status).toBe(403);
    expect((await h.db.query('SELECT 1 FROM campaigns WHERE org_id = $1', [org])).rowCount).toBe(0);
  });

  it('lets an analyst read but not write', async () => {
    const owner = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: owner.user.id });
    const campaign = await makeCampaign(h.db, { orgId: org });
    const analyst = await signedIn();
    await addMember(h.db, org, analyst.user.id, 'analyst');

    expect((await analyst.cl.get(`/api/v1/orgs/${org}/campaigns/${campaign}`)).status).toBe(200);
    expect((await analyst.cl.patch(`/api/v1/orgs/${org}/campaigns/${campaign}`, { name: 'Renamed' })).status).toBe(403);
  });

  it('stops a manager from inviting members or minting API keys', async () => {
    const owner = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: owner.user.id });
    const manager = await signedIn();
    await addMember(h.db, org, manager.user.id, 'manager');

    expect((await manager.cl.post(`/api/v1/orgs/${org}/invitations`, { email: 'x@example.com', role: 'analyst' })).status).toBe(403);
    expect((await manager.cl.post(`/api/v1/orgs/${org}/api-keys`, { name: 'key', scopes: ['read'] })).status).toBe(403);
  });

  it('stops a member from promoting themselves', async () => {
    const owner = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: owner.user.id });
    const manager = await signedIn();
    await addMember(h.db, org, manager.user.id, 'manager');

    const r = await manager.cl.patch(`/api/v1/orgs/${org}/members/${manager.user.id}`, { role: 'owner' });
    expect(r.status).toBe(403);
    const role = await h.db.query<{ role: string }>('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [org, manager.user.id]);
    expect(role.rows[0]!.role).toBe('manager');
  });
});

describe('platform administration', () => {
  it('refuses every admin endpoint to an ordinary user', async () => {
    const u = await signedIn();
    for (const url of [
      '/api/v1/admin/overview',
      '/api/v1/admin/users',
      '/api/v1/admin/orgs',
      '/api/v1/admin/campaigns',
      '/api/v1/admin/finance/summary',
      '/api/v1/admin/settings',
      '/api/v1/admin/audit',
      '/api/v1/admin/security/summary',
    ]) {
      const r = await u.cl.get(url);
      expect(r.status, url).toBe(403);
    }
  });

  it('refuses admin endpoints to anyone not signed in', async () => {
    const cl = new Client(h.app);
    expect((await cl.get('/api/v1/admin/overview')).status).toBe(401);
  });

  it('lets a user grant themselves no platform role', async () => {
    const u = await signedIn();
    const r = await u.cl.req('PUT', `/api/v1/admin/users/${u.user.id}/role`, { body: { platformRole: 'super_admin', reason: 'self promotion attempt' } });
    expect(r.status).toBe(403);
    const after = await h.db.query<{ platform_role: string | null }>('SELECT platform_role FROM users WHERE id = $1', [u.user.id]);
    expect(after.rows[0]!.platform_role).toBeNull();
  });

  it('keeps finance staff out of user management and settings', async () => {
    const f = await signedIn(undefined, { platformRole: 'finance' });
    expect((await f.cl.get('/api/v1/admin/finance/summary')).status).toBe(200);
    expect((await f.cl.get('/api/v1/admin/settings')).status).toBe(403);
    const victim = await makeUser(h.db);
    await stepUp(f.cl);
    expect((await f.cl.post(`/api/v1/admin/users/${victim.id}/suspend`, { reason: 'because' })).status).toBe(403);
  });

  it('keeps ad operations staff out of the money', async () => {
    const ops = await signedIn(undefined, { platformRole: 'ad_ops' });
    expect((await ops.cl.get('/api/v1/admin/campaigns')).status).toBe(200);
    expect((await ops.cl.get('/api/v1/admin/finance/summary')).status).toBe(403);
    expect((await ops.cl.get('/api/v1/admin/finance/ledger')).status).toBe(403);
  });

  it('stops an administrator from creating another administrator', async () => {
    const admin = await signedIn(undefined, { platformRole: 'admin' });
    const victim = await makeUser(h.db);
    await stepUp(admin.cl);
    const r = await admin.cl.req('PUT', `/api/v1/admin/users/${victim.id}/role`, { body: { platformRole: 'super_admin', reason: 'escalation attempt' } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const after = await h.db.query<{ platform_role: string | null }>('SELECT platform_role FROM users WHERE id = $1', [victim.id]);
    expect(after.rows[0]!.platform_role).not.toBe('super_admin');
  });

  it('will not let the last super administrator be stripped of their role', async () => {
    const sa = await signedIn(undefined, { platformRole: 'super_admin' });
    await stepUp(sa.cl);
    const r = await sa.cl.req('PUT', `/api/v1/admin/users/${sa.user.id}/role`, { body: { platformRole: null, reason: 'locking myself out' } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const after = await h.db.query<{ platform_role: string | null }>('SELECT platform_role FROM users WHERE id = $1', [sa.user.id]);
    expect(after.rows[0]!.platform_role).toBe('super_admin');
  });

  it('can reach an organisation an ordinary user cannot', async () => {
    const owner = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: owner.user.id });
    const sa = await signedIn(undefined, { platformRole: 'super_admin' });
    const r = await sa.cl.get(`/api/v1/admin/orgs/${org}`);
    expect(r.status).toBe(200);
  });
});

describe('suspension', () => {
  it('ends every session of a suspended user', async () => {
    const victim = await signedIn();
    expect((await victim.cl.get('/api/v1/auth/me')).status).toBe(200);
    const admin = await signedIn(undefined, { platformRole: 'super_admin' });
    await stepUp(admin.cl);
    const r = await admin.cl.post(`/api/v1/admin/users/${victim.user.id}/suspend`, { reason: 'Policy violation' });
    expect(r.status).toBeLessThan(300);
    expect((await victim.cl.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('lets a suspended organisation be read but not changed', async () => {
    const owner = await signedIn();
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: owner.user.id, status: 'suspended' });
    expect((await owner.cl.get(`/api/v1/orgs/${org}`)).status).toBe(200);
    const r = await owner.cl.post(`/api/v1/orgs/${org}/campaigns`, {
      name: 'While suspended',
      pricingModel: 'cpm',
      rate: '2.00',
      lifetimeBudget: '100',
      startAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    expect(r.status).toBe(403);
  });
});

describe('unverified email addresses', () => {
  it('can read but cannot create', async () => {
    const u = await signedIn(undefined, { verified: false });
    const org = await makeOrg(h.db, { type: 'advertiser', ownerId: u.user.id });
    expect((await u.cl.get(`/api/v1/orgs/${org}`)).status).toBe(200);
    const r = await u.cl.post(`/api/v1/orgs/${org}/campaigns`, {
      name: 'Unverified campaign',
      pricingModel: 'cpm',
      rate: '2.00',
      lifetimeBudget: '100',
      startAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    expect(r.status).toBe(403);
  });
});
