import { describe, expect, it } from 'vitest';
import {
  ADMIN_CAMPAIGN_TRANSITIONS,
  ADVERTISER_CAMPAIGN_TRANSITIONS,
  CAMPAIGN_STATUSES,
  grantablePlatformRoles,
  ORG_ROLES,
  ORG_ROLE_PERMISSIONS,
  ORG_TYPES,
  orgRoleHas,
  PLATFORM_ROLES,
  PLATFORM_ROLE_PERMISSIONS,
  platformRoleHas,
  ROLE_LABELS,
  type CampaignStatus,
  type OrgPermission,
  type PlatformRole,
} from '@blissnova/shared';

describe('organisation roles', () => {
  it('gives an advertiser owner the permissions the portal needs', () => {
    for (const p of ['campaign:write', 'creative:write', 'billing:fund', 'org:members:manage', 'org:apikeys:manage'] as OrgPermission[]) {
      expect(orgRoleHas('advertiser', 'owner', p), p).toBe(true);
    }
  });

  it('gives a publisher owner the permissions the portal needs', () => {
    for (const p of ['site:write', 'unit:write', 'earnings:read', 'payout:request'] as OrgPermission[]) {
      expect(orgRoleHas('publisher', 'owner', p), p).toBe(true);
    }
  });

  it('keeps money out of a manager\'s hands', () => {
    expect(orgRoleHas('advertiser', 'manager', 'billing:fund')).toBe(false);
    expect(orgRoleHas('publisher', 'manager', 'payout:request')).toBe(false);
  });

  it('keeps an analyst read-only', () => {
    for (const type of ORG_TYPES) {
      for (const p of ORG_ROLE_PERMISSIONS[type].analyst) {
        expect(p.endsWith(':read'), `${type} analyst has ${p}`).toBe(true);
      }
    }
  });

  it('never lets an analyst or manager take over the organisation', () => {
    for (const type of ORG_TYPES) {
      for (const role of ['manager', 'analyst'] as const) {
        expect(orgRoleHas(type, role, 'org:members:manage'), `${type}/${role}`).toBe(false);
        expect(orgRoleHas(type, role, 'org:apikeys:manage'), `${type}/${role}`).toBe(false);
        expect(orgRoleHas(type, role, 'org:update'), `${type}/${role}`).toBe(false);
      }
    }
  });

  it('does not leak publisher permissions to advertisers or the reverse', () => {
    for (const role of ORG_ROLES) {
      expect(orgRoleHas('advertiser', role, 'site:write'), role).toBe(false);
      expect(orgRoleHas('advertiser', role, 'payout:request'), role).toBe(false);
      expect(orgRoleHas('publisher', role, 'campaign:write'), role).toBe(false);
      expect(orgRoleHas('publisher', role, 'billing:fund'), role).toBe(false);
    }
  });

  it('gives every role at least the ability to read its own organisation', () => {
    for (const type of ORG_TYPES) {
      for (const role of ORG_ROLES) {
        expect(orgRoleHas(type, role, 'org:read'), `${type}/${role}`).toBe(true);
      }
    }
  });

  it('is monotonic: an owner can do everything a manager can, and a manager everything an analyst can', () => {
    for (const type of ORG_TYPES) {
      const owner = new Set(ORG_ROLE_PERMISSIONS[type].owner);
      const manager = new Set(ORG_ROLE_PERMISSIONS[type].manager);
      for (const p of manager) expect(owner.has(p), `${type} owner missing ${p}`).toBe(true);
      for (const p of ORG_ROLE_PERMISSIONS[type].analyst) expect(manager.has(p), `${type} manager missing ${p}`).toBe(true);
    }
  });
});

describe('platform roles', () => {
  it('treats no role as no access at all', () => {
    expect(platformRoleHas(null, 'admin:overview')).toBe(false);
    expect(platformRoleHas(undefined, 'admin:overview')).toBe(false);
  });

  it('gives super administrators everything', () => {
    for (const p of PLATFORM_ROLE_PERMISSIONS.super_admin) {
      expect(platformRoleHas('super_admin', p)).toBe(true);
    }
  });

  it('confines finance staff to money, with no power over users or settings', () => {
    expect(platformRoleHas('finance', 'admin:finance:manage')).toBe(true);
    expect(platformRoleHas('finance', 'admin:payouts:manage')).toBe(true);
    expect(platformRoleHas('finance', 'admin:users:manage')).toBe(false);
    expect(platformRoleHas('finance', 'admin:settings:manage')).toBe(false);
    expect(platformRoleHas('finance', 'admin:roles:manage')).toBe(false);
    expect(platformRoleHas('finance', 'admin:campaigns:review')).toBe(false);
  });

  it('confines ad operations to inventory and campaigns, with no access to money', () => {
    expect(platformRoleHas('ad_ops', 'admin:campaigns:review')).toBe(true);
    expect(platformRoleHas('ad_ops', 'admin:creatives:review')).toBe(true);
    expect(platformRoleHas('ad_ops', 'admin:finance:read')).toBe(false);
    expect(platformRoleHas('ad_ops', 'admin:finance:manage')).toBe(false);
    expect(platformRoleHas('ad_ops', 'admin:payouts:manage')).toBe(false);
    expect(platformRoleHas('ad_ops', 'admin:roles:manage')).toBe(false);
  });

  it('leaves support staff able to look but not change', () => {
    const allowed = new Set(PLATFORM_ROLE_PERMISSIONS.support);
    for (const p of allowed) {
      expect(p.endsWith(':read') || p === 'admin:overview' || p === 'admin:notes:write', `support has ${p}`).toBe(true);
    }
    expect(platformRoleHas('support', 'admin:users:manage')).toBe(false);
    expect(platformRoleHas('support', 'admin:finance:manage')).toBe(false);
  });

  it('reserves role management for super administrators', () => {
    expect(platformRoleHas('super_admin', 'admin:roles:manage')).toBe(true);
    for (const role of ['finance', 'ad_ops', 'support'] as PlatformRole[]) {
      expect(platformRoleHas(role, 'admin:roles:manage'), role).toBe(false);
    }
  });

  describe('who may grant which role', () => {
    it('lets a super administrator grant any role', () => {
      expect(grantablePlatformRoles('super_admin').sort()).toEqual([...PLATFORM_ROLES].sort());
    });

    it('stops an administrator from creating another administrator or a super administrator', () => {
      const g = grantablePlatformRoles('admin');
      expect(g).not.toContain('super_admin');
      expect(g).not.toContain('admin');
      expect(g.sort()).toEqual(['ad_ops', 'finance', 'support']);
    });

    it('lets everyone else grant nothing', () => {
      for (const role of ['finance', 'ad_ops', 'support'] as PlatformRole[]) {
        expect(grantablePlatformRoles(role), role).toEqual([]);
      }
      expect(grantablePlatformRoles(null)).toEqual([]);
    });
  });

  it('labels all eleven roles for the interface', () => {
    expect(PLATFORM_ROLES.length + ORG_TYPES.length * ORG_ROLES.length).toBe(11);
    for (const r of PLATFORM_ROLES) expect(ROLE_LABELS[r], r).toBeTruthy();
    for (const t of ORG_TYPES) for (const r of ORG_ROLES) expect(ROLE_LABELS[`${t}:${r}`], `${t}:${r}`).toBeTruthy();
  });
});

describe('campaign status transitions', () => {
  // Each map is action -> the statuses the action may be applied from.
  it('only ever names real statuses', () => {
    for (const map of [ADVERTISER_CAMPAIGN_TRANSITIONS, ADMIN_CAMPAIGN_TRANSITIONS]) {
      for (const [action, froms] of Object.entries(map)) {
        expect(froms.length, action).toBeGreaterThan(0);
        for (const from of froms) expect(CAMPAIGN_STATUSES, `${action} from ${from}`).toContain(from);
      }
    }
  });

  it('lets an advertiser submit a draft or a rejected campaign for review', () => {
    expect(ADVERTISER_CAMPAIGN_TRANSITIONS.submit).toContain('draft');
    expect(ADVERTISER_CAMPAIGN_TRANSITIONS.submit).toContain('rejected');
  });

  it('gives an advertiser no action that approves a campaign', () => {
    // Approval is an administrator action only; an advertiser cannot reach
    // 'active' from 'pending_approval' by any route they control.
    expect(Object.keys(ADVERTISER_CAMPAIGN_TRANSITIONS)).not.toContain('approve');
    expect(ADVERTISER_CAMPAIGN_TRANSITIONS.resume).not.toContain('pending_approval');
  });

  it('never lets an advertiser lift a suspension', () => {
    expect(ADVERTISER_CAMPAIGN_TRANSITIONS.resume).not.toContain('suspended');
    expect(ADVERTISER_CAMPAIGN_TRANSITIONS.resume).toEqual(['paused']);
  });

  it('lets an advertiser pause and resume their own campaign', () => {
    expect(ADVERTISER_CAMPAIGN_TRANSITIONS.pause).toContain('active');
    expect(ADVERTISER_CAMPAIGN_TRANSITIONS.resume).toContain('paused');
  });

  it('only lets an advertiser archive a campaign that is not delivering', () => {
    for (const from of ADVERTISER_CAMPAIGN_TRANSITIONS.archive!) {
      expect(['active', 'scheduled'], from).not.toContain(from);
    }
  });

  it('lets an administrator approve or reject only a campaign awaiting review', () => {
    expect(ADMIN_CAMPAIGN_TRANSITIONS.approve).toEqual(['pending_approval']);
    expect(ADMIN_CAMPAIGN_TRANSITIONS.reject).toEqual(['pending_approval']);
  });

  it('lets an administrator suspend a campaign at any live stage', () => {
    for (const from of ['active', 'scheduled', 'paused', 'pending_approval']) {
      expect(ADMIN_CAMPAIGN_TRANSITIONS.suspend, from).toContain(from as CampaignStatus);
    }
  });

  it('lets only an administrator resume a suspended campaign', () => {
    expect(ADMIN_CAMPAIGN_TRANSITIONS.resume).toContain('suspended');
  });

  it('gives an administrator every starting point an advertiser has for a shared action', () => {
    for (const [action, froms] of Object.entries(ADVERTISER_CAMPAIGN_TRANSITIONS)) {
      const adminFroms = ADMIN_CAMPAIGN_TRANSITIONS[action];
      if (!adminFroms) continue; // submit and archive are advertiser-only
      for (const from of froms) {
        expect(adminFroms, `admin cannot ${action} from ${from}`).toContain(from);
      }
    }
  });

  it('does not allow any action on an archived campaign', () => {
    for (const map of [ADVERTISER_CAMPAIGN_TRANSITIONS, ADMIN_CAMPAIGN_TRANSITIONS]) {
      for (const [action, froms] of Object.entries(map)) {
        expect(froms, action).not.toContain('archived');
      }
    }
  });
});
