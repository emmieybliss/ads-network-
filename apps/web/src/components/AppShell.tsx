'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  BarChart3, Bell, Building2, ChevronsUpDown, CreditCard, FileText, Gauge, Globe2, KeyRound, LayoutDashboard, LifeBuoy, LogOut, Megaphone, Menu,
  ScrollText, Settings, Shield, ShieldAlert, SlidersHorizontal, Ticket, Users, Wallet, X, Image as ImageIcon, Landmark, Activity, Search, Network,
} from 'lucide-react';
import { Badge, Loading, Logo, cn } from './ui';
import { useSession, type OrgSummary } from '@/lib/session';
import { useApi } from '@/lib/hooks';
import { brand } from '@/lib/brand';
import { humanize, timeAgo } from '@/lib/format';
import { post } from '@/lib/api';

export type Portal = 'advertiser' | 'publisher' | 'admin' | 'account';
type NavItem = { href: string; label: string; icon: typeof Gauge; perm?: string };

const NAV: Record<Exclude<Portal, 'account'>, Array<{ section?: string; items: NavItem[] }>> = {
  advertiser: [
    { items: [
      { href: '/advertiser', label: 'Overview', icon: LayoutDashboard },
      { href: '/advertiser/campaigns', label: 'Campaigns', icon: Megaphone },
      { href: '/advertiser/reports', label: 'Reports', icon: BarChart3 },
      { href: '/advertiser/billing', label: 'Billing', icon: Wallet, perm: 'billing:read' },
    ] },
  ],
  publisher: [
    { items: [
      { href: '/publisher', label: 'Overview', icon: LayoutDashboard },
      { href: '/publisher/sites', label: 'Websites', icon: Globe2 },
      { href: '/publisher/reports', label: 'Reports', icon: BarChart3 },
      { href: '/publisher/earnings', label: 'Earnings & payouts', icon: Wallet, perm: 'earnings:read' },
      { href: '/publisher/policy', label: 'Policy & traffic quality', icon: ShieldAlert },
    ] },
  ],
  admin: [
    { items: [{ href: '/admin', label: 'Overview', icon: Gauge, perm: 'admin:overview' }] },
    { section: 'Network', items: [
      { href: '/admin/users', label: 'Users', icon: Users, perm: 'admin:users:read' },
      { href: '/admin/orgs', label: 'Organizations', icon: Building2, perm: 'admin:orgs:read' },
      { href: '/admin/sites', label: 'Publisher sites', icon: Globe2, perm: 'admin:orgs:read' },
      { href: '/admin/domains', label: 'Domains', icon: Search, perm: 'admin:orgs:read' },
      { href: '/admin/campaigns', label: 'Campaigns', icon: Megaphone, perm: 'admin:campaigns:read' },
      { href: '/admin/creatives', label: 'Creative review', icon: ImageIcon, perm: 'admin:creatives:review' },
      { href: '/admin/partners', label: 'Partner networks', icon: Network, perm: 'admin:campaigns:read' },
    ] },
    { section: 'Money', items: [
      { href: '/admin/finance', label: 'Finance', icon: Landmark, perm: 'admin:finance:read' },
      { href: '/admin/payouts', label: 'Payouts', icon: CreditCard, perm: 'admin:finance:read' },
      { href: '/admin/pricing', label: 'Pricing', icon: SlidersHorizontal, perm: 'admin:settings:read' },
    ] },
    { section: 'Trust', items: [
      { href: '/admin/fraud', label: 'Invalid traffic', icon: ShieldAlert, perm: 'admin:fraud:read' },
      { href: '/admin/security', label: 'Security', icon: Shield, perm: 'admin:security:read' },
      { href: '/admin/audit', label: 'Audit log', icon: ScrollText, perm: 'admin:audit:read' },
      { href: '/admin/support', label: 'Support', icon: LifeBuoy, perm: 'admin:users:read' },
    ] },
    { section: 'Platform', items: [
      { href: '/admin/settings', label: 'Settings', icon: Settings, perm: 'admin:settings:read' },
      { href: '/admin/content', label: 'Content', icon: FileText, perm: 'admin:content:manage' },
      { href: '/admin/system', label: 'System health', icon: Activity, perm: 'admin:overview' },
    ] },
  ],
};

const ACCOUNT_NAV: NavItem[] = [
  { href: '/account/team', label: 'Team', icon: Users, perm: 'org:read' },
  { href: '/account/api-keys', label: 'API keys', icon: KeyRound, perm: 'org:apikeys:manage' },
  { href: '/account/organization', label: 'Organization', icon: Building2, perm: 'org:read' },
  { href: '/support', label: 'Support', icon: Ticket },
  { href: '/account/security', label: 'Sign-in & security', icon: Shield },
];

function OrgSwitcher({ orgs, current, onPick }: { orgs: OrgSummary[]; current: OrgSummary | null; onPick: (o: OrgSummary) => void }) {
  const [open, setOpen] = useState(false);
  if (!current) return null;
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 text-left hover:bg-surface-2" aria-expanded={open}>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary-soft text-xs font-semibold text-primary">{current.name.slice(0, 2).toUpperCase()}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-fg">{current.name}</span>
          <span className="block text-[11px] capitalize text-muted">{current.type} · {current.role}</span>
        </span>
        <ChevronsUpDown className="size-4 text-muted" aria-hidden />
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 rounded-lg border border-border bg-surface p-1 shadow-[var(--shadow-pop)]">
          {orgs.map((o) => (
            <button key={o.id} onClick={() => { setOpen(false); onPick(o); }} className={cn('flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-surface-2', o.id === current.id && 'bg-surface-2')}>
              <span className="truncate">{o.name}</span><span className="text-[11px] capitalize text-muted">{o.type}</span>
            </button>
          ))}
          <Link href="/onboarding" className="block rounded-md px-2.5 py-2 text-[13px] text-primary hover:bg-surface-2">+ New organization</Link>
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const res = useApi<{ data: Array<{ id: string; title: string; body: string; link: string | null; read_at: string | null; created_at: string }>; unread: number }>('/notifications');
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="relative rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Notifications">
        <Bell className="size-5" />
        {res.data && res.data.unread > 0 && <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-accent text-[10px] font-semibold text-white">{Math.min(res.data.unread, 9)}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 rounded-xl border border-border bg-surface shadow-[var(--shadow-pop)]">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-sm font-medium">Notifications</span>
            {res.data && res.data.unread > 0 && <button className="text-xs text-primary hover:underline" onClick={async () => { await post('/notifications/read-all'); res.reload(); }}>Mark all read</button>}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {!res.data ? <Loading /> : res.data.data.length === 0 ? <p className="p-4 text-sm text-muted">No notifications yet.</p> : res.data.data.map((n) => (
              <Link key={n.id} href={n.link ?? '#'} onClick={() => setOpen(false)} className={cn('block border-b border-border px-4 py-3 last:border-0 hover:bg-surface-2', !n.read_at && 'bg-primary-soft/40')}>
                <p className="text-[13px] font-medium text-fg">{n.title}</p>
                {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{n.body}</p>}
                <p className="mt-1 text-[11px] text-muted">{timeAgo(n.created_at)}</p>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function AppShell({ portal, children }: { portal: Portal; children: ReactNode }) {
  const { me, loading, org, setOrgId, logout, can, canAdmin } = useSession();
  const router = useRouter();
  const path = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Guards: signed in, and the right kind of account for this portal.
  useEffect(() => {
    if (loading) return;
    if (!me) {
      router.replace(`/login?next=${encodeURIComponent(path)}`);
      return;
    }
    if (portal === 'admin' && !me.platformRole) router.replace('/app');
    if ((portal === 'advertiser' || portal === 'publisher') && org?.type !== portal) {
      const match = me.organizations.find((o) => o.type === portal);
      if (match) setOrgId(match.id);
      else router.replace(me.organizations.length ? '/app' : '/onboarding');
    }
  }, [loading, me, org, portal, path, router, setOrgId]);

  useEffect(() => setMobileOpen(false), [path]);

  if (loading || !me) return <Loading label="Loading your workspace…" />;
  if (portal === 'admin' && !me.platformRole) return <Loading />;
  if ((portal === 'advertiser' || portal === 'publisher') && org?.type !== portal) return <Loading />;

  const effectivePortal: Exclude<Portal, 'account'> = portal === 'account' ? (org?.type ?? 'advertiser') : portal;
  const groups = NAV[effectivePortal].map((g) => ({ ...g, items: g.items.filter((i) => !i.perm || (effectivePortal === 'admin' ? canAdmin(i.perm) : can(i.perm))) })).filter((g) => g.items.length);
  const accountItems = portal === 'admin' ? [] : ACCOUNT_NAV.filter((i) => !i.perm || can(i.perm));
  const isActive = (href: string) => (href === `/${effectivePortal}` ? path === href : path === href || path.startsWith(`${href}/`));

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center justify-between px-4">
        <Link href="/app"><Logo name={brand.shortName} /></Link>
        {portal === 'admin' && <Badge tone="accent">Admin</Badge>}
      </div>
      {portal !== 'admin' && me.organizations.length > 0 && (
        <div className="px-3 pb-3">
          <OrgSwitcher orgs={me.organizations} current={org} onPick={(o) => { setOrgId(o.id); router.push(o.type === 'advertiser' ? '/advertiser' : '/publisher'); }} />
        </div>
      )}
      <nav className="flex-1 space-y-4 overflow-y-auto px-3 pb-4" aria-label="Portal">
        {groups.map((g, gi) => (
          <div key={gi}>
            {g.section && <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{g.section}</p>}
            {g.items.map((i) => (
              <Link key={i.href} href={i.href} aria-current={isActive(i.href) ? 'page' : undefined} className={cn('mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] transition-colors', isActive(i.href) ? 'bg-primary-soft font-medium text-primary' : 'text-fg-2 hover:bg-surface-2 hover:text-fg')}>
                <i.icon className="size-4 shrink-0" aria-hidden /> {i.label}
              </Link>
            ))}
          </div>
        ))}
        {accountItems.length > 0 && (
          <div>
            <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted">Account</p>
            {accountItems.map((i) => (
              <Link key={i.href} href={i.href} aria-current={isActive(i.href) ? 'page' : undefined} className={cn('mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px]', isActive(i.href) ? 'bg-primary-soft font-medium text-primary' : 'text-fg-2 hover:bg-surface-2 hover:text-fg')}>
                <i.icon className="size-4 shrink-0" aria-hidden /> {i.label}
              </Link>
            ))}
          </div>
        )}
      </nav>
      <div className="border-t border-border p-3">
        {me.platformRole && portal !== 'admin' && <Link href="/admin" className="mb-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-fg-2 hover:bg-surface-2"><Shield className="size-4" /> Admin control center</Link>}
        {portal === 'admin' && me.organizations.length > 0 && <Link href="/app" className="mb-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-fg-2 hover:bg-surface-2"><LayoutDashboard className="size-4" /> My organizations</Link>}
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{me.name}</p>
            <p className="truncate text-[11px] text-muted">{me.platformRole ? humanize(me.platformRole) : me.email}</p>
          </div>
          <button onClick={() => void logout()} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Sign out" title="Sign out"><LogOut className="size-4" /></button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="sticky top-0 hidden h-screen border-r border-border bg-surface lg:block">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-border bg-surface">{sidebar}</aside>
        </div>
      )}
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-bg/85 px-4 backdrop-blur sm:px-6">
          <button className="rounded-md p-2 text-fg lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu className="size-5" /></button>
          <div className="hidden min-w-0 items-center gap-2 text-sm text-muted lg:flex">
            {portal === 'admin' ? 'Admin control center' : org ? <>{org.name}{org.status !== 'approved' && <Badge tone="warning">Organization {org.status}</Badge>}</> : null}
          </div>
          <div className="flex items-center gap-1">
            <Notifications />
            {mobileOpen && <X className="size-5" />}
          </div>
        </header>
        {!me.emailVerified && (
          <div className="border-b border-border bg-warning-soft px-4 py-2 text-center text-sm text-warning sm:px-6">
            Verify your email address to unlock every feature. <button className="font-medium underline" onClick={() => void post('/auth/resend-verification')}>Resend the link</button>
          </div>
        )}
        {(process.env.NEXT_PUBLIC_DEMO_MODE === 'true' || org?.name.includes('[demo]')) && (
          <div role="note" className="border-b border-border bg-info-soft px-4 py-2 text-center text-sm text-info sm:px-6">
            Demo environment. Accounts, campaigns and the statistics shown here are generated sample data, not real traffic or revenue.
          </div>
        )}
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
