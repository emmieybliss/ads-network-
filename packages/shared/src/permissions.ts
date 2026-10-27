/**
 * Role-based access control. This matrix is the single source of truth and
 * is enforced on the server (apps/api). The dashboard reads it only to
 * decide which navigation to show; hiding UI is never authorization.
 *
 * Roles are deliberately defined in code rather than editable database rows:
 * a permission change is a reviewed code change, which prevents privilege
 * escalation through a compromised admin session editing role tables.
 */
export const PLATFORM_ROLES = ['super_admin', 'admin', 'finance', 'ad_ops', 'support'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const ORG_TYPES = ['advertiser', 'publisher'] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export const ORG_ROLES = ['owner', 'manager', 'analyst'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Administrator',
  admin: 'Administrator',
  finance: 'Finance Staff',
  ad_ops: 'Ad Operations Staff',
  support: 'Support Staff',
  'advertiser:owner': 'Advertiser Owner',
  'advertiser:manager': 'Advertiser Manager',
  'advertiser:analyst': 'Advertiser Analyst',
  'publisher:owner': 'Publisher Owner',
  'publisher:manager': 'Publisher Manager',
  'publisher:analyst': 'Publisher Analyst',
};

export type OrgPermission =
  | 'org:read' | 'org:update' | 'org:members:manage' | 'org:apikeys:manage'
  | 'campaign:read' | 'campaign:write' | 'creative:read' | 'creative:write'
  | 'report:read' | 'billing:read' | 'billing:fund'
  | 'site:read' | 'site:write' | 'unit:read' | 'unit:write'
  | 'earnings:read' | 'payout:request';

export type PlatformPermission =
  | 'admin:overview'
  | 'admin:users:read' | 'admin:users:manage' | 'admin:roles:manage'
  | 'admin:orgs:read' | 'admin:orgs:review' | 'admin:orgs:suspend'
  | 'admin:sites:review' | 'admin:inventory:manage'
  | 'admin:campaigns:read' | 'admin:campaigns:review' | 'admin:campaigns:override'
  | 'admin:creatives:review'
  | 'admin:pricing:manage'
  | 'admin:finance:read' | 'admin:finance:manage' | 'admin:payouts:manage'
  | 'admin:fraud:read' | 'admin:fraud:manage'
  | 'admin:settings:read' | 'admin:settings:manage'
  | 'admin:security:read' | 'admin:security:manage'
  | 'admin:audit:read' | 'admin:content:manage' | 'admin:notes:write';

const ADVERTISER_ALL: OrgPermission[] = ['org:read', 'org:update', 'org:members:manage', 'org:apikeys:manage', 'campaign:read', 'campaign:write', 'creative:read', 'creative:write', 'report:read', 'billing:read', 'billing:fund'];
const PUBLISHER_ALL: OrgPermission[] = ['org:read', 'org:update', 'org:members:manage', 'org:apikeys:manage', 'site:read', 'site:write', 'unit:read', 'unit:write', 'report:read', 'earnings:read', 'payout:request'];

export const ORG_ROLE_PERMISSIONS: Record<OrgType, Record<OrgRole, readonly OrgPermission[]>> = {
  advertiser: {
    owner: ADVERTISER_ALL,
    manager: ['org:read', 'campaign:read', 'campaign:write', 'creative:read', 'creative:write', 'report:read', 'billing:read'],
    analyst: ['org:read', 'campaign:read', 'creative:read', 'report:read'],
  },
  publisher: {
    owner: PUBLISHER_ALL,
    manager: ['org:read', 'site:read', 'site:write', 'unit:read', 'unit:write', 'report:read', 'earnings:read'],
    analyst: ['org:read', 'site:read', 'unit:read', 'report:read', 'earnings:read'],
  },
};

const ALL_PLATFORM: PlatformPermission[] = [
  'admin:overview', 'admin:users:read', 'admin:users:manage', 'admin:roles:manage', 'admin:orgs:read', 'admin:orgs:review', 'admin:orgs:suspend',
  'admin:sites:review', 'admin:inventory:manage', 'admin:campaigns:read', 'admin:campaigns:review', 'admin:campaigns:override', 'admin:creatives:review',
  'admin:pricing:manage', 'admin:finance:read', 'admin:finance:manage', 'admin:payouts:manage', 'admin:fraud:read', 'admin:fraud:manage',
  'admin:settings:read', 'admin:settings:manage', 'admin:security:read', 'admin:security:manage', 'admin:audit:read', 'admin:content:manage', 'admin:notes:write',
];

export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRole, readonly PlatformPermission[]> = {
  super_admin: ALL_PLATFORM,
  // Administrators hold every permission; granting or revoking super_admin/admin is further restricted in the role service.
  admin: ALL_PLATFORM,
  finance: ['admin:overview', 'admin:users:read', 'admin:orgs:read', 'admin:campaigns:read', 'admin:finance:read', 'admin:finance:manage', 'admin:payouts:manage', 'admin:pricing:manage', 'admin:audit:read', 'admin:notes:write', 'admin:fraud:read'],
  ad_ops: ['admin:overview', 'admin:users:read', 'admin:orgs:read', 'admin:orgs:review', 'admin:sites:review', 'admin:inventory:manage', 'admin:campaigns:read', 'admin:campaigns:review', 'admin:campaigns:override', 'admin:creatives:review', 'admin:fraud:read', 'admin:fraud:manage', 'admin:settings:read', 'admin:notes:write'],
  support: ['admin:overview', 'admin:users:read', 'admin:orgs:read', 'admin:campaigns:read', 'admin:fraud:read', 'admin:notes:write'],
};

export function orgRoleHas(orgType: OrgType, role: OrgRole, perm: OrgPermission): boolean {
  return ORG_ROLE_PERMISSIONS[orgType][role].includes(perm);
}

export function platformRoleHas(role: PlatformRole | null | undefined, perm: PlatformPermission): boolean {
  if (!role) return false;
  return PLATFORM_ROLE_PERMISSIONS[role].includes(perm);
}

/** Which platform roles may an actor grant or revoke. */
export function grantablePlatformRoles(actor: PlatformRole | null | undefined): PlatformRole[] {
  if (actor === 'super_admin') return [...PLATFORM_ROLES];
  if (actor === 'admin') return ['finance', 'ad_ops', 'support'];
  return [];
}
