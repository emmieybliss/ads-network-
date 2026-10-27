'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, get, post } from './api';

export interface OrgSummary {
  id: string;
  name: string;
  type: 'advertiser' | 'publisher';
  status: string;
  currency: string;
  role: 'owner' | 'manager' | 'analyst';
  permissions: string[];
}

export interface Me {
  id: string;
  email: string;
  name: string;
  platformRole: string | null;
  platformPermissions: string[];
  mfaEnabled: boolean;
  emailVerified: boolean;
  organizations: OrgSummary[];
}

interface SessionValue {
  me: Me | null;
  loading: boolean;
  org: OrgSummary | null;
  setOrgId: (id: string) => void;
  refresh: () => Promise<Me | null>;
  logout: () => Promise<void>;
  /** Org-level permission in the current organisation. */
  can: (perm: string) => boolean;
  /** Platform (staff) permission. */
  canAdmin: (perm: string) => boolean;
}

const Ctx = createContext<SessionValue | null>(null);
const ORG_KEY = 'bn_current_org';

function readStoredOrg(): string | null {
  try {
    return window.localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgIdState] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await get<{ user: Me }>('/auth/me');
      setMe(r.user);
      return r.user;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) console.warn('session check failed', e);
      setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setOrgIdState(readStoredOrg());
    void refresh();
  }, [refresh]);

  const setOrgId = useCallback((id: string) => {
    setOrgIdState(id);
    try {
      window.localStorage.setItem(ORG_KEY, id);
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout');
    } finally {
      setMe(null);
      window.location.href = '/login';
    }
  }, []);

  const org = useMemo(() => {
    if (!me || me.organizations.length === 0) return null;
    return me.organizations.find((o) => o.id === orgId) ?? me.organizations[0]!;
  }, [me, orgId]);

  const value: SessionValue = {
    me,
    loading,
    org,
    setOrgId,
    refresh,
    logout,
    can: (perm) => Boolean(org?.permissions.includes(perm)),
    canAdmin: (perm) => Boolean(me?.platformPermissions.includes(perm)),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}

/** The current organization inside a portal layout, where AppShell guarantees one exists. */
export function useOrg(): OrgSummary {
  const { org } = useSession();
  if (!org) throw new Error('useOrg used outside a portal layout');
  return org;
}
