import type { ReactNode } from 'react';
import {
  BarChart3, Bell, Check, ChevronDown, Download, Filter, Globe2, KeyRound, LayoutDashboard, LifeBuoy, Megaphone, ShieldCheck, Users, Wallet, X,
} from 'lucide-react';
import { clsx as cn } from 'clsx';

/*
 * Product mockups for the marketing site. They are drawn with the same layout,
 * navigation and tokens as the real portals (see app/(app)), so they look like
 * the product. Every figure in them is sample data and the frames say so.
 */

export function SampleTag({ className }: { className?: string }) {
  return <span className={cn('rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted', className)}>Sample data</span>;
}

/** Window chrome around a mockup. */
export function Frame({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-xl border border-border bg-bg shadow-[0_30px_60px_-20px_rgb(16_24_40/0.35),0_18px_36px_-18px_rgb(16_24_40/0.3)]', className)}>
      <div className="flex items-center gap-1.5 border-b border-border bg-surface px-3 py-2">
        <span className="size-2.5 rounded-full bg-[#ff5f57]" /><span className="size-2.5 rounded-full bg-[#febc2e]" /><span className="size-2.5 rounded-full bg-[#28c840]" />
        <SampleTag className="ml-2" />
        <span className="ml-auto hidden max-w-[50%] truncate rounded-md bg-surface-2 px-3 py-0.5 text-[10.5px] text-muted sm:mr-auto sm:block">{label ?? 'BlissNova'}</span>
      </div>
      {children}
    </div>
  );
}

type NavItem = [typeof LayoutDashboard, string];
const PUB_NAV: NavItem[] = [[LayoutDashboard, 'Overview'], [Globe2, 'Websites'], [BarChart3, 'Reports'], [Wallet, 'Earnings & payouts'], [ShieldCheck, 'Policy & traffic quality']];
const ADV_NAV: NavItem[] = [[LayoutDashboard, 'Overview'], [Megaphone, 'Campaigns'], [BarChart3, 'Reports'], [Wallet, 'Billing']];
const ACCOUNT_NAV: NavItem[] = [[Users, 'Team'], [KeyRound, 'API keys'], [LifeBuoy, 'Support']];

function Sidebar({ org, role, nav, active }: { org: string; role: string; nav: NavItem[]; active: string }) {
  return (
    <aside className="hidden w-[168px] shrink-0 flex-col border-r border-border bg-surface p-2.5 md:flex">
      <div className="flex items-center gap-1.5 px-1.5 py-1">
        <span className="flex size-5 items-center justify-center rounded-md bg-[linear-gradient(135deg,var(--primary),var(--accent))] text-[9px] text-white">✦</span>
        <span className="text-[12px] font-semibold">BlissNova</span>
      </div>
      <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-border px-1.5 py-1.5">
        <span className="flex size-5 items-center justify-center rounded bg-primary-soft text-[8px] font-semibold text-primary">{org.slice(0, 2).toUpperCase()}</span>
        <span className="min-w-0 flex-1"><span className="block truncate text-[10.5px] font-medium">{org}</span><span className="block text-[9px] text-muted">{role}</span></span>
        <ChevronDown className="size-3 text-muted" aria-hidden />
      </div>
      <nav className="mt-2 space-y-0.5">
        {nav.map(([I, l]) => (
          <span key={l} className={cn('flex items-center gap-1.5 rounded-md px-1.5 py-1.5 text-[10.5px]', l === active ? 'bg-primary-soft font-medium text-primary' : 'text-fg-2')}>
            <I className="size-3.5" aria-hidden /> <span className="truncate">{l}</span>
          </span>
        ))}
      </nav>
      <p className="mt-3 px-1.5 text-[8.5px] font-semibold uppercase tracking-wider text-muted">Account</p>
      <nav className="mt-1 space-y-0.5">
        {ACCOUNT_NAV.map(([I, l]) => <span key={l} className="flex items-center gap-1.5 px-1.5 py-1.5 text-[10.5px] text-fg-2"><I className="size-3.5" aria-hidden /> {l}</span>)}
      </nav>
    </aside>
  );
}

function TopBar({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2">
      <span className="text-[11px] text-muted">{title}</span>
      <Bell className="size-3.5 text-muted" aria-hidden />
    </div>
  );
}

function Kpi({ label, value, delta, sub }: { label: string; value: string; delta?: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-2.5 shadow-[var(--shadow-card)]">
      <p className="truncate text-[9.5px] text-muted">{label}</p>
      <p className="tabular mt-0.5 text-[15px] font-semibold tracking-tight">{value}</p>
      {delta && <p className="tabular text-[9px] font-medium text-success">{delta}</p>}
      {sub && <p className="text-[9px] text-primary">{sub}</p>}
    </div>
  );
}

/** Smooth area chart with a light grid, drawn in SVG. */
export function AreaChart({ series, height = 120, labels, className, id }: { series: Array<{ data: number[]; color: string; fill?: boolean }>; height?: number; labels?: string[]; className?: string; id: string }) {
  const W = 400;
  const H = height;
  const max = Math.max(...series.flatMap((s) => s.data)) * 1.12;
  const path = (d: number[]) => {
    const pts = d.map((v, i) => [(i / (d.length - 1)) * W, H - (v / max) * (H - 6)] as const);
    return pts.reduce((acc, [x, y], i) => {
      if (i === 0) return `M${x},${y}`;
      const [px, py] = pts[i - 1];
      const cx = (px + x) / 2;
      return `${acc} C${cx},${py} ${cx},${y} ${x},${y}`;
    }, '');
  };
  return (
    <div className={className}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={i} id={`${id}-${i}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={s.color} stopOpacity=".26" />
              <stop offset="1" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="var(--border)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />)}
        {series.map((s, i) => (
          <g key={i}>
            {s.fill !== false && <path d={`${path(s.data)} L${W},${H} L0,${H} Z`} fill={`url(#${id}-${i})`} />}
            <path d={path(s.data)} fill="none" stroke={s.color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </svg>
      {labels && (
        <div className="mt-1 flex justify-between text-[8.5px] text-muted tabular">{labels.map((l) => <span key={l}>{l}</span>)}</div>
      )}
    </div>
  );
}

const PUB_IMPR = [11.2, 11.8, 12.4, 12.1, 13.0, 14.2, 13.6, 13.9, 14.8, 15.6, 15.1, 15.9, 16.8, 16.2, 17.4, 18.1, 17.6, 18.8, 19.4, 18.9, 20.2, 21.0];
const PUB_REV = [3.1, 3.3, 3.6, 3.4, 3.9, 4.4, 4.1, 4.2, 4.6, 5.0, 4.8, 5.1, 5.6, 5.3, 5.9, 6.3, 6.0, 6.5, 6.9, 6.6, 7.2, 7.6];
const DATES = ['Oct 6', 'Oct 11', 'Oct 16', 'Oct 21', 'Oct 27'];

/** Publisher overview, as in /publisher. */
export function PublisherDashboardMock({ className }: { className?: string }) {
  return (
    <Frame className={className} label="Publisher · Overview">
      <div className="flex">
        <Sidebar org="Sample Media" role="Publisher · Owner" nav={PUB_NAV} active="Overview" />
        <div className="min-w-0 flex-1">
          <TopBar title="Sample Media" />
          <div className="p-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[15px] font-semibold tracking-tight">Overview</p>
                <p className="text-[10px] text-muted">Last 30 days across your websites</p>
              </div>
              <span className="rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-primary-fg">+ Add website</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Kpi label="Estimated earnings" value="$1,284.60" delta="▲ 18.2% vs prior" />
              <Kpi label="Page RPM" value="$7.42" delta="▲ 6.1%" />
              <Kpi label="Valid impressions" value="412,380" delta="▲ 12.7%" />
              <Kpi label="Viewability" value="71.4%" sub="Policy & quality" />
            </div>
            <div className="mt-2.5 rounded-lg border border-border bg-surface p-3 shadow-[var(--shadow-card)]">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold">Earnings and impressions</p>
                <div className="flex gap-2.5 text-[9px] text-muted">
                  <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-chart-1" />Impressions</span>
                  <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-chart-3" />Earnings</span>
                </div>
              </div>
              <AreaChart id="pub-hero" className="mt-2" height={112} labels={DATES} series={[{ data: PUB_IMPR, color: 'var(--chart-1)' }, { data: PUB_REV.map((v) => v * 2.2), color: 'var(--chart-3)', fill: false }]} />
            </div>
            <div className="mt-2.5 overflow-hidden rounded-lg border border-border bg-surface shadow-[var(--shadow-card)]">
              <div className="grid grid-cols-[1.6fr_1fr_.8fr_.8fr] gap-2 bg-surface-2 px-3 py-1.5 text-[8.5px] font-semibold uppercase tracking-wide text-muted">
                <span>Placement</span><span className="text-right">Impressions</span><span className="text-right">RPM</span><span className="text-right">Earnings</span>
              </div>
              {[
                ['In-article native', '148,920', '$3.62', '$539.09'],
                ['Sticky bottom anchor', '121,404', '$2.41', '$292.58'],
                ['Header leaderboard', '86,110', '$2.95', '$254.02'],
                ['Right side rail', '55,946', '$3.55', '$198.91'],
              ].map((r) => (
                <div key={r[0]} className="grid grid-cols-[1.6fr_1fr_.8fr_.8fr] gap-2 border-t border-border px-3 py-1.5 text-[10px]">
                  <span className="truncate text-fg-2">{r[0]}</span><span className="tabular text-right">{r[1]}</span><span className="tabular text-right">{r[2]}</span><span className="tabular text-right font-medium">{r[3]}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}

/** Advertiser campaign detail, as in /advertiser/campaigns/[id]. */
export function CampaignMock({ className }: { className?: string }) {
  return (
    <Frame className={className} label="Advertiser · Campaign">
      <div className="flex">
        <Sidebar org="Sample Brand" role="Advertiser · Owner" nav={ADV_NAV} active="Campaigns" />
        <div className="min-w-0 flex-1">
          <TopBar title="Sample Brand" />
          <div className="p-4">
            <p className="text-[9.5px] text-muted">‹ Campaigns</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <p className="text-[15px] font-semibold tracking-tight">Autumn collection launch</p>
              <span className="rounded-full bg-success-soft px-1.5 py-0.5 text-[9px] font-medium text-success">Active</span>
              <span className="rounded-full bg-info-soft px-1.5 py-0.5 text-[9px] font-medium text-info">CPM · Even pacing</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Kpi label="Spend" value="$1,246.30" />
              <Kpi label="Valid impressions" value="498,520" />
              <Kpi label="Valid clicks" value="4,187" />
              <Kpi label="CTR" value="0.84%" />
            </div>
            <div className="mt-2.5 grid gap-2.5 lg:grid-cols-[1.25fr_1fr]">
              <div className="rounded-lg border border-border bg-surface p-3 shadow-[var(--shadow-card)]">
                <div className="flex items-center justify-between text-[11px]"><span className="font-semibold">Budget pacing</span><span className="text-success">On pace</span></div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2"><div className="h-full w-[62%] rounded-full bg-[linear-gradient(90deg,var(--primary),var(--chart-3))]" /></div>
                <div className="mt-1.5 flex justify-between text-[9px] text-muted tabular"><span>$1,246.30 spent</span><span>$2,000.00 lifetime</span></div>
                <AreaChart id="cmp" className="mt-2" height={64} series={[{ data: [40, 42, 41, 44, 46, 45, 47, 49, 48, 50, 52, 51, 53], color: 'var(--chart-1)' }]} />
              </div>
              <div className="rounded-lg border border-border bg-surface p-3 shadow-[var(--shadow-card)]">
                <p className="text-[11px] font-semibold">Targeting</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {['United States', 'Canada', 'United Kingdom', 'Desktop', 'Mobile', 'Home & garden', 'Lifestyle'].map((t) => <span key={t} className="rounded-md bg-primary-soft px-1.5 py-0.5 text-[9px] font-medium text-primary">{t}</span>)}
                </div>
                <p className="mt-2.5 text-[9.5px] text-muted">Frequency cap</p>
                <p className="text-[10.5px] font-medium">3 per visitor / 24 hours</p>
                <p className="mt-1.5 text-[9.5px] text-muted">Schedule</p>
                <p className="text-[10.5px] font-medium">Oct 1 – Nov 30</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}

/** Admin review queue, as in /admin/creatives and /admin/sites. */
export function ReviewQueueMock({ className }: { className?: string }) {
  const rows: Array<[string, string, string, string]> = [
    ['Creative', 'Autumn collection · native', 'Sample Brand', 'Pending'],
    ['Website', 'gardening-notes.example', 'Sample Media', 'Verified'],
    ['Campaign', 'Weekend sale · CPM', 'Sample Retail', 'Pending'],
    ['Creative', 'Spring banner · 300×250', 'Sample Travel', 'Pending'],
  ];
  return (
    <Frame className={className} label="Admin · Review queue">
      <div className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[15px] font-semibold tracking-tight">Review queue</p>
            <p className="text-[10px] text-muted">Nothing serves until it is approved</p>
          </div>
          <div className="flex gap-1.5">
            {[['Creatives', 12], ['Sites', 4], ['Campaigns', 3]].map(([l, n]) => <span key={l} className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[9.5px]"><b className="tabular">{n}</b> {l}</span>)}
          </div>
        </div>
        <div className="mt-3 overflow-hidden rounded-lg border border-border bg-surface shadow-[var(--shadow-card)]">
          {rows.map(([kind, name, org, status], i) => (
            <div key={name} className={cn('flex items-center gap-2.5 px-3 py-2 text-[10.5px]', i && 'border-t border-border')}>
              <span className="w-14 shrink-0 text-[9px] font-semibold uppercase tracking-wide text-muted">{kind}</span>
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{name}</span><span className="block text-[9px] text-muted">{org}</span></span>
              <span className={cn('rounded-full px-1.5 py-0.5 text-[9px] font-medium', status === 'Verified' ? 'bg-info-soft text-info' : 'bg-warning-soft text-warning')}>{status}</span>
              <span className="hidden items-center gap-1 sm:flex">
                <span className="flex size-5 items-center justify-center rounded-md bg-success-soft text-success"><Check className="size-3" aria-hidden /></span>
                <span className="flex size-5 items-center justify-center rounded-md bg-danger-soft text-danger"><X className="size-3" aria-hidden /></span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </Frame>
  );
}

const REPORT_ROWS: Array<[string, string, string, string, string, string, string]> = [
  ['United States', '182,410', '74.2%', '1,602', '0.88%', '$3.12', '1.4%'],
  ['United Kingdom', '64,288', '71.0%', '498', '0.77%', '$2.86', '1.1%'],
  ['Canada', '41,905', '72.6%', '351', '0.84%', '$2.74', '0.9%'],
  ['Germany', '33,117', '69.8%', '231', '0.70%', '$2.41', '2.0%'],
  ['Australia', '21,560', '70.5%', '172', '0.80%', '$2.66', '1.2%'],
];

/** Report explorer, as in /publisher/reports and /advertiser/reports. */
export function ReportsMock({ className }: { className?: string }) {
  return (
    <Frame className={className} label="Reports · Explorer">
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[15px] font-semibold tracking-tight">Reports</p>
          <div className="flex gap-1.5 text-[10px]">
            <span className="flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1"><Filter className="size-3" aria-hidden />Last 30 days</span>
            <span className="flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1"><Download className="size-3" aria-hidden />CSV</span>
          </div>
        </div>
        <div className="mt-3 flex gap-1 overflow-x-auto border-b border-border text-[10.5px]">
          {['Date', 'Site', 'Placement', 'Page', 'Country', 'Device', 'Creative'].map((t) => (
            <span key={t} className={cn('shrink-0 px-2 pb-1.5', t === 'Country' ? 'border-b-2 border-primary font-medium text-primary' : 'text-muted')}>{t}</span>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Kpi label="Valid impressions" value="343,280" />
          <Kpi label="Viewable rate" value="72.9%" />
          <Kpi label="CTR" value="0.83%" />
          <Kpi label="Invalid traffic" value="1.4%" />
        </div>
        <div className="mt-3 rounded-lg border border-border bg-surface p-3 shadow-[var(--shadow-card)]">
          <div className="flex h-24 items-end gap-[3px]">
            {[38, 44, 41, 52, 49, 57, 61, 55, 63, 66, 60, 70, 74, 68, 77, 81, 75, 84, 88, 83, 91, 95, 89, 97].map((v, i) => (
              <div key={i} className="flex flex-1 flex-col justify-end gap-[2px]" style={{ height: '100%' }}>
                <div className="rounded-t-[2px] bg-chart-1" style={{ height: `${v * 0.62}%` }} />
                <div className="rounded-b-[2px] bg-chart-1/35" style={{ height: `${v * 0.3}%` }} />
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-3 text-[9px] text-muted">
            <span className="flex items-center gap-1"><span className="size-1.5 rounded-sm bg-chart-1" />Viewable</span>
            <span className="flex items-center gap-1"><span className="size-1.5 rounded-sm bg-chart-1/35" />Not viewable</span>
          </div>
        </div>
        <div className="mt-3 overflow-x-auto rounded-lg border border-border bg-surface shadow-[var(--shadow-card)]">
          <table className="w-full min-w-[440px] text-[10px]">
            <thead className="bg-surface-2 text-[8.5px] uppercase tracking-wide text-muted">
              <tr>{['Country', 'Impressions', 'Viewable', 'Clicks', 'CTR', 'eCPM', 'IVT'].map((h, i) => <th key={h} className={cn('px-3 py-1.5 font-semibold', i ? 'text-right' : 'text-left')}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {REPORT_ROWS.map((r) => (
                <tr key={r[0]} className="border-t border-border">
                  {r.map((c, i) => <td key={i} className={cn('px-3 py-1.5', i ? 'tabular text-right' : 'text-fg-2')}>{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Frame>
  );
}

/** A native ad as the ad tag renders it on a publisher page. */
export function NativeAdCard({ className }: { className?: string }) {
  return (
    <div className={cn('w-[220px] overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-pop)]', className)}>
      <div className="h-24 bg-[linear-gradient(135deg,#f6d365,#fda085_45%,#e8613c)]">
        <svg viewBox="0 0 220 96" className="h-full w-full" aria-hidden>
          <circle cx="170" cy="30" r="16" fill="#fff6" />
          <path d="M0 96 L60 50 L100 78 L150 36 L220 90 L220 96 Z" fill="#7a3b2e55" />
          <path d="M0 96 L40 70 L90 92 L140 60 L220 96 Z" fill="#5a2a2066" />
        </svg>
      </div>
      <div className="p-3">
        <p className="text-[9px] font-medium uppercase tracking-wide text-muted">Sponsored · Sample Outdoor Co.</p>
        <p className="mt-1 text-[12px] font-semibold leading-snug">Trail-ready gear for the first frost</p>
        <p className="mt-2 inline-block rounded-md bg-fg px-2 py-1 text-[10px] font-medium text-bg">Shop the range</p>
      </div>
    </div>
  );
}

/** Small wireframe of a web page, with the ad position highlighted. */
export function FormatThumb({ kind }: { kind: 'display' | 'in-article' | 'native' | 'in-feed' | 'anchor' | 'rail' | 'interstitial' | 'text' }) {
  const line = (w: string, k?: number) => <div key={k} className="h-1.5 rounded-full bg-border" style={{ width: w }} />;
  const ad = 'rounded-[4px] bg-[linear-gradient(135deg,var(--primary),color-mix(in_srgb,var(--primary)_50%,var(--accent)))] shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_18%,transparent)]';
  const text = <div className="space-y-1.5">{line('92%', 1)}{line('80%', 2)}{line('86%', 3)}</div>;
  return (
    <div className="relative h-36 overflow-hidden rounded-lg border border-border bg-surface p-3" aria-hidden>
      <div className="mb-2.5 flex items-center gap-1.5"><span className="size-2 rounded-full bg-border-strong" />{line('30%')}</div>
      {kind === 'display' && (<>{text}<div className={cn(ad, 'mx-auto mt-2.5 h-6 w-[78%]')} /><div className="mt-2.5">{text}</div></>)}
      {kind === 'in-article' && (<>{text}<div className={cn(ad, 'mt-2.5 h-10 w-full')} /><div className="mt-2.5">{text}</div></>)}
      {kind === 'native' && (
        <>{text}<div className="mt-2.5 flex gap-2 rounded-md border border-primary/40 p-1.5"><div className={cn(ad, 'h-9 w-12 shrink-0')} /><div className="flex-1 space-y-1">{line('40%')}{line('90%')}{line('70%')}</div></div></>
      )}
      {kind === 'in-feed' && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className={cn('flex gap-2 rounded-md p-1', i === 1 && 'border border-primary/40')}>
              <div className={cn('h-7 w-9 shrink-0 rounded-[4px]', i === 1 ? ad : 'bg-surface-2')} />
              <div className="flex-1 space-y-1">{line('85%')}{line('55%')}</div>
            </div>
          ))}
        </div>
      )}
      {kind === 'anchor' && (<>{text}<div className="mt-2.5">{text}</div><div className={cn(ad, 'absolute inset-x-2 bottom-2 h-5')} /></>)}
      {kind === 'rail' && (
        <div className="flex gap-2"><div className="flex-1">{text}<div className="mt-2.5">{text}</div><div className="mt-2.5">{text}</div></div><div className={cn(ad, 'h-20 w-6 shrink-0')} /></div>
      )}
      {kind === 'interstitial' && (
        <>{text}<div className="mt-2.5">{text}</div>
          <div className="absolute inset-0 flex items-center justify-center bg-fg/45"><div className="w-[62%] rounded-md bg-surface p-1.5"><div className="mb-1 flex justify-end"><span className="size-1.5 rounded-full bg-muted" /></div><div className={cn(ad, 'h-12 w-full')} /></div></div>
        </>
      )}
      {kind === 'text' && (
        <div className="flex gap-2"><div className="flex-1">{text}<div className="mt-2.5">{text}</div></div><div className="w-14 shrink-0 space-y-1 rounded-md border border-primary/40 p-1.5"><div className="h-1.5 w-full rounded-full bg-primary" />{line('100%')}{line('80%')}<div className="h-1.5 w-1/2 rounded-full bg-primary/60" /></div></div>
      )}
    </div>
  );
}
