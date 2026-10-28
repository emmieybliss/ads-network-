'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Card, cn } from '../ui';
import { useApi } from '@/lib/hooks';
import { formatMicros, formatNumber } from '@/lib/format';

const axis = { stroke: 'var(--muted)', fontSize: 11, tickLine: false, axisLine: false } as const;
const tooltipStyle = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12, color: 'var(--fg)' };

/** Display names for dimension values the API returns as keys. */
export const DIMENSION_LABELS: Record<string, Record<string, string>> = {
  device: { desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet', other: 'Other' },
  os: { windows: 'Windows', macos: 'macOS', ios: 'iOS / iPadOS', android: 'Android', linux: 'Linux', chromeos: 'ChromeOS', other: 'Other' },
  browser: { chrome: 'Chrome', safari: 'Safari', firefox: 'Firefox', edge: 'Edge', samsung: 'Samsung Internet', opera: 'Opera', in_app: 'In-app browser', other: 'Other' },
  source: { search: 'Search', social: 'Social', direct: 'Direct', referral: 'Referral', internal: 'Internal navigation', unknown: 'Not recorded' },
  display: { inline: 'In-page', anchor: 'Anchor', rail_left: 'Side rail (left)', rail_right: 'Side rail (right)', interstitial: 'Interstitial' },
  format: { image: 'Display (image)', text: 'Text', native: 'Native' },
};

const REGION_NAMES = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
/** English name for an ISO 3166 alpha-2 code; "ZZ" is traffic whose country could not be told. */
export function countryName(code: string | null | undefined): string {
  if (!code) return '—';
  if (code === 'ZZ') return 'Unknown';
  try { return REGION_NAMES?.of(code) ?? code; } catch { return code; }
}

export function dimLabel(dim: string, key: string | null | undefined, fallback?: string | null): string {
  if (key === null || key === undefined) return fallback ?? '—';
  if (dim === 'country') return countryName(key);
  return DIMENSION_LABELS[dim]?.[key] ?? fallback ?? key;
}

/** Percentage change against the previous period, with direction. `invert` marks metrics where lower is better. */
export function Delta({ now, before, invert, compact }: { now: number | null | undefined; before: number | null | undefined; invert?: boolean; compact?: boolean }) {
  if (now === null || now === undefined || before === null || before === undefined) return <span className="text-xs text-muted">{compact ? '—' : 'no comparison'}</span>;
  if (before === 0) return <span className="whitespace-nowrap text-xs text-muted">{now === 0 ? (compact ? '—' : 'no change') : compact ? 'New' : 'new this period'}</span>;
  const pct = ((now - before) / Math.abs(before)) * 100;
  const flat = Math.abs(pct) < 0.5;
  const good = flat ? null : (pct > 0) !== !!invert;
  const Icon = flat ? Minus : pct > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn('inline-flex items-center gap-0.5 whitespace-nowrap text-xs font-medium', good === null ? 'text-muted' : good ? 'text-success' : 'text-danger')}>
      <Icon className="size-3.5" aria-hidden />
      {flat ? 'no change' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}
      <span className="sr-only">{good === null ? '' : good ? '(better)' : '(worse)'}</span>
    </span>
  );
}

/** Small line of the period's daily values, for KPI tiles. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2 || values.every((v) => v === 0)) return <div className={cn('h-8', className)} />;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const w = 120;
  const hgt = 32;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${hgt - 2 - ((v - min) / (max - min || 1)) * (hgt - 4)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${hgt}`} preserveAspectRatio="none" className={cn('h-8 w-full', className)} aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--chart-1)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function KpiTile({ label, value, delta, spark, definition }: { label: string; value: ReactNode; delta?: ReactNode; spark?: number[]; definition?: string }) {
  return (
    <Card className="min-w-0">
      <div className="text-[13px] text-muted">
        <span title={definition} className={cn(definition && 'cursor-help underline decoration-dotted underline-offset-4')}>{label}</span>
      </div>
      <div className="tabular mt-1 truncate text-[22px] font-semibold tracking-tight text-fg">{value}</div>
      <div className="mt-0.5 flex items-center justify-between gap-2">{delta}</div>
      {spark && <Sparkline values={spark} className="mt-2" />}
    </Card>
  );
}

/** One metric over the period, with the previous period as a dashed line on the same axis. */
export function PeriodChart({ days, current, previous, label, format, height = 280 }: { days: string[]; current: number[]; previous: number[] | null; label: string; format: (v: number) => string; height?: number }) {
  const rows = days.map((d, i) => ({ day: d.slice(5), current: current[i] ?? 0, previous: previous?.[i] ?? null }));
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="day" {...axis} minTickGap={16} />
          <YAxis {...axis} width={64} tickFormatter={(v) => format(Number(v))} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [v === null ? '—' : format(Number(v)), name]} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="current" name={`${label}, this period`} stroke="var(--chart-1)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          {previous && <Line type="monotone" dataKey="previous" name="Previous period" stroke="var(--muted)" strokeWidth={2} strokeDasharray="4 4" dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Funnel as horizontal bars, each step's share of the first and of the step before. */
export function Funnel({ steps }: { steps: Array<{ key: string; label: string; value: number }> }) {
  const top = steps[0]?.value ?? 0;
  return (
    <ol className="space-y-2.5">
      {steps.map((s, i) => {
        const prev = i > 0 ? steps[i - 1]!.value : null;
        const share = top ? (s.value / top) * 100 : 0;
        return (
          <li key={s.key} className="grid grid-cols-[minmax(110px,150px)_1fr_auto] items-center gap-3 text-sm">
            <span className="text-fg-2">{s.label}</span>
            <div className="h-6 rounded-[4px] bg-surface-2" title={`${s.label}: ${formatNumber(s.value)}`}>
              <div className="h-6 rounded-[4px] bg-[var(--chart-1)]" style={{ width: `${Math.min(100, Math.max(share, s.value ? 0.6 : 0))}%`, opacity: 1 - i * 0.08 }} />
            </div>
            <span className="tabular w-36 text-right">
              <span className="font-medium text-fg">{formatNumber(s.value)}</span>
              {prev !== null && <span className="ml-1.5 text-xs text-muted">{prev ? `${((s.value / prev) * 100).toFixed(1)}%` : '—'}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Weekday x hour grid; darker is more. One hue, light to dark. */
export function Heatmap({ cells, metric, format }: { cells: Array<Record<string, any>>; metric: string; format: (v: number) => string }) {
  const value = (c: Record<string, any> | undefined) => (c ? Number(c[metric] ?? 0) : 0);
  const max = Math.max(0, ...cells.map(value));
  const at = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c]));
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <div className="grid min-w-[520px] grid-cols-[36px_repeat(24,minmax(0,1fr))] gap-[2px] text-[10px] text-muted">
        <div />
        {Array.from({ length: 24 }, (_, h) => <div key={h} className="text-center">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</div>)}
        {DAYS.map((d, i) => (
          <div key={d} className="contents">
            <div className="flex items-center pr-1 text-[11px]">{d}</div>
            {Array.from({ length: 24 }, (_, h) => {
              const c = at.get(`${i + 1}:${h}`);
              const v = value(c);
              const t = max ? v / max : 0;
              return (
                <div key={h} title={`${d} ${String(h).padStart(2, '0')}:00 UTC: ${format(v)}`} className="aspect-square rounded-[3px] border border-transparent hover:border-fg"
                  style={{ background: v ? `color-mix(in oklab, var(--chart-1) ${Math.round(12 + t * 88)}%, var(--surface))` : 'var(--surface-2)' }} />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs text-muted">
        <span>Less</span>
        {[12, 34, 56, 78, 100].map((p) => <span key={p} className="size-3 rounded-[3px]" style={{ background: `color-mix(in oklab, var(--chart-1) ${p}%, var(--surface))` }} />)}
        <span>More</span>
        <span className="ml-auto">Hours in UTC</span>
      </div>
    </div>
  );
}

/** Ranked values with a share bar each; for breakdowns and reasons. */
export function ShareBars({ rows, format }: { rows: Array<{ key: string; label: string; value: number; extra?: ReactNode }>; format?: (v: number) => string }) {
  const total = rows.reduce((a, r) => a + r.value, 0);
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length || !total) return <p className="py-6 text-center text-sm text-muted">Nothing recorded in this period.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.key} className="text-sm">
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="truncate text-fg-2">{r.label}</span>
            <span className="tabular shrink-0 text-fg">{format ? format(r.value) : formatNumber(r.value)} <span className="text-xs text-muted">{((r.value / total) * 100).toFixed(1)}%</span>{r.extra}</span>
          </div>
          <div className="h-1.5 rounded-full bg-surface-2"><div className="h-1.5 rounded-full bg-[var(--chart-1)]" style={{ width: `${(r.value / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

/** The last 30 minutes, refreshed every 15 seconds while the tab is visible. */
export function RealtimePanel({ path, currency, topLabel }: { path: string; currency: string; topLabel: string }) {
  const res = useApi<{ data: { at: string; money: string; totals: Record<string, any>; activePages: number; minutes: Array<Record<string, any>>; top: Array<Record<string, any>>; countries?: Array<Record<string, any>> } }>(path);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible' && !paused) res.reload(); }, 15_000);
    return () => clearInterval(t);
  }, [paused, res.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = res.data?.data;
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-fg">
            <span className="relative flex size-2.5"><span className={cn('absolute inline-flex size-full rounded-full bg-success opacity-60', !paused && 'animate-ping')} /><span className="relative inline-flex size-2.5 rounded-full bg-success" /></span>
            Real time
          </h2>
          <p className="mt-0.5 text-sm text-muted">Last 30 minutes from the event log, updated every 15 seconds{d ? `, last at ${new Date(d.at).toLocaleTimeString()}` : ''}.</p>
        </div>
        <button className="text-xs font-medium text-primary hover:underline" onClick={() => setPaused((p) => !p)}>{paused ? 'Resume updates' : 'Pause updates'}</button>
      </div>
      {!d ? <div className="h-40 animate-pulse rounded-lg bg-surface-2" /> : (
        <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
          <div>
            <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Mini label="Valid impressions" value={formatNumber(d.totals.validImpressions)} />
              <Mini label="Valid clicks" value={formatNumber(d.totals.validClicks)} />
              <Mini label={d.money === 'earnings' ? 'Est. earnings' : 'Spend'} value={formatMicros(d.totals.micros, currency)} />
              <Mini label="Pages with ads now" value={formatNumber(d.activePages)} hint="last 5 minutes" />
            </div>
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={d.minutes} margin={{ top: 4, right: 4, bottom: 0, left: -16 }} barCategoryGap={2}>
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" {...axis} interval={4} />
                  <YAxis {...axis} allowDecimals={false} width={44} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--surface-2)' }} formatter={(v, n) => [Number(v).toLocaleString(), n]} labelFormatter={(l) => `${l} UTC`} />
                  <Bar dataKey="validImpressions" name="Valid impressions" fill="var(--chart-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{topLabel}</div>
            {d.top.length === 0 ? <p className="text-sm text-muted">No ads delivered in the last 30 minutes.</p> : (
              <ul className="space-y-1.5 text-sm">
                {d.top.map((r) => (
                  <li key={r.label} className="flex justify-between gap-3"><span className="truncate text-fg-2" title={r.label}>{r.label}</span><span className="tabular text-fg">{formatNumber(r.validImpressions)}</span></li>
                ))}
              </ul>
            )}
            {d.countries && d.countries.length > 0 && (
              <>
                <div className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-muted">Countries now</div>
                <ul className="space-y-1.5 text-sm">
                  {d.countries.slice(0, 5).map((r) => (
                    <li key={r.country} className="flex justify-between gap-3"><span className="truncate text-fg-2">{countryName(r.country)}</span><span className="tabular text-fg">{formatNumber(r.validImpressions)}</span></li>
                  ))}
                </ul>
              </>
            )}
            {d.totals.invalidEvents > 0 && <div className="mt-3"><Badge tone="warning">{formatNumber(d.totals.invalidEvents)} invalid events filtered</Badge></div>}
          </div>
        </div>
      )}
    </Card>
  );
}

function Mini({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg bg-surface-2/70 px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="tabular text-lg font-semibold text-fg">{value}</div>
      {hint && <div className="text-[10px] text-muted">{hint}</div>}
    </div>
  );
}
