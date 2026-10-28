'use client';
import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Download, Info, Sparkles, TrendingUp } from 'lucide-react';
import { Async, Card, CardHeader, EmptyState, Field, Input, Select, Table, Tabs, cn, type Column } from '../ui';
import { useApi } from '@/lib/hooks';
import { qs } from '@/lib/api';
import { formatMicros, formatNumber, formatPercent, isoDay } from '@/lib/format';
import { Delta, Funnel, Heatmap, KpiTile, PeriodChart, RealtimePanel, ShareBars, countryName, dimLabel } from './parts';
import { CountryMap } from './CountryMap';
import { ReportEmailControl } from './ReportEmail';

type Audience = 'advertiser' | 'publisher' | 'admin';
type Row = Record<string, any> & { key: string; label: string };
interface Analytics {
  audience: Audience;
  currency: string;
  range: { from: string; to: string; days: number };
  previousRange: { from: string; to: string };
  totals: Record<string, any>;
  previous: Record<string, any>;
  previousTrend: Row[];
  trend: Row[];
  breakdowns: Record<string, Row[]>;
  placements: Row[];
  countries: { rows: Row[]; count: number };
  heatmap: { timezone: string; money: string; cells: Array<Record<string, any>> };
  funnel: Array<{ key: string; label: string; value: number }>;
  requests: Record<string, number | null> | null;
  ivt: Array<{ type: string; reason: string; events: number }>;
  traffic: null | { pageviews: number; sessions: number; pagesPerSession: number | null; sessionRpmMicros: string | null; pageRpmMicros: string | null; bySource: Array<Record<string, any>>; byDevice: Array<Record<string, any>>; trend: Array<Record<string, any>> };
  reach: null | { available: boolean; maxDays: number; reach?: number; frequency?: number | null; identifiedShare?: number | null };
  conversionEvents: null | Array<{ event: string; conversions: number; valueMicros: string; avgHoursToConvert: number | null }>;
  insights: Array<{ tone: 'good' | 'warn' | 'info'; title: string; detail: string }>;
  definitions: Record<string, string>;
}

const PRESETS = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7', label: '7 days', days: 7 },
  { id: '30', label: '30 days', days: 30 },
  { id: '90', label: '90 days', days: 90 },
] as const;

function rangeFor(days: number) {
  return { from: isoDay(new Date(Date.now() - (days - 1) * 86_400_000)), to: isoDay(new Date()) };
}

const IVT_REASONS: Record<string, string> = {
  duplicate: 'Duplicate event', replay: 'Replayed token', token_expired: 'Expired token', token_invalid: 'Invalid token', crawler: 'Known crawler or bot',
  domain_mismatch: 'Served on an unapproved domain', site_inactive: 'Site not approved', sequence: 'Out of order (no valid render)', rate_anomaly: 'Request rate anomaly',
  click_too_fast: 'Click too fast after render', click_burst: 'Click burst from one visitor', anomaly_score: 'Combined anomaly score', tracking_disabled: 'Tracking switched off', manual_exclusion: 'Excluded by review',
};
const IVT_TYPES: Record<string, string> = { render: 'Impressions', click: 'Clicks', viewable: 'Viewable reports', inview: 'Time-in-view reports' };

/**
 * Analytics for one organization or the whole network: totals with the
 * previous period, trend, real time, funnel, heatmap, breakdowns, placement
 * viewability, sessions (publishers), conversions and reach (advertisers),
 * invalid traffic by reason and plain-language insights. Every number comes
 * from the analytics API, which reads validated events only.
 */
export function AnalyticsDashboard({ basePath, audience, currency, filters = {}, exportPath, reportEmailPath }: { basePath: string; audience: Audience; currency: string; filters?: Record<string, string | undefined>; exportPath?: string; reportEmailPath?: string }) {
  const [preset, setPreset] = useState<string>('30');
  const [range, setRange] = useState(rangeFor(30));
  const query = qs({ ...range, ...filters });
  const res = useApi<{ data: Analytics }>(`${basePath}${query}`);
  const choose = (id: string, days: number) => { setPreset(id); setRange(rangeFor(days)); };

  return (
    <div className="space-y-5">
      <Card padded={false} className="px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5" role="group" aria-label="Date range">
            {PRESETS.map((p) => (
              <button key={p.id} onClick={() => choose(p.id, p.days)} aria-pressed={preset === p.id}
                className={cn('rounded-md px-3 py-1.5 text-[13px] font-medium', preset === p.id ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg')}>{p.label}</button>
            ))}
          </div>
          <Field label="From" htmlFor="an-from"><Input id="an-from" type="date" value={range.from} max={range.to} onChange={(e) => { setPreset('custom'); setRange({ ...range, from: e.target.value }); }} /></Field>
          <Field label="To" htmlFor="an-to"><Input id="an-to" type="date" value={range.to} min={range.from} onChange={(e) => { setPreset('custom'); setRange({ ...range, to: e.target.value }); }} /></Field>
          {res.data && <span className="pb-2 text-xs text-muted">Compared with {res.data.data.previousRange.from} to {res.data.data.previousRange.to}</span>}
          {exportPath && (
            <a href={`/api/v1${exportPath}${qs({ ...range, ...filters, groupBy: 'day' })}`} className="ml-auto inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3.5 text-sm font-medium shadow-sm hover:bg-surface-2">
              <Download className="size-4" aria-hidden /> Export CSV
            </a>
          )}
        </div>
        {reportEmailPath && <div className="mt-3 border-t border-border pt-3"><ReportEmailControl path={reportEmailPath} /></div>}
      </Card>

      <Async res={res}>
        {({ data }) => <Body a={data} currency={currency} audience={audience} live={<RealtimePanel path={`${basePath}/realtime${qs(filters)}`} currency={currency} topLabel={audience === 'advertiser' ? 'Top campaigns now' : 'Top pages now'} />} />}
      </Async>
    </div>
  );
}

function Body({ a, currency, audience, live }: { a: Analytics; currency: string; audience: Audience; live: ReactNode }) {
  const t = a.totals;
  const p = a.previous;
  const money = (v: unknown) => formatMicros(v as string, currency);
  const pub = audience === 'publisher';
  const moneyKey = pub ? 'earningsMicros' : 'spendMicros';
  const spark = (k: string) => a.trend.map((r) => Number(r[k] ?? 0));
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const empty = (t.served ?? 0) === 0 && (t.validImpressions ?? 0) === 0;

  const metrics = useMemo(() => {
    const list: Array<{ id: string; label: string; get: (r: Record<string, any>) => number; fmt: (v: number) => string }> = [
      { id: 'validImpressions', label: 'Valid impressions', get: (r) => r.validImpressions ?? 0, fmt: (v) => formatNumber(Math.round(v)) },
      { id: 'validClicks', label: 'Valid clicks', get: (r) => r.validClicks ?? 0, fmt: (v) => formatNumber(Math.round(v)) },
      { id: 'ctr', label: 'CTR', get: (r) => r.ctr ?? 0, fmt: (v) => formatPercent(v) },
      { id: 'viewabilityRate', label: 'Viewability', get: (r) => r.viewabilityRate ?? 0, fmt: (v) => formatPercent(v, 1) },
    ];
    if (audience !== 'advertiser') list.splice(2, 0, { id: 'earnings', label: pub ? 'Estimated earnings' : 'Publisher earnings', get: (r) => Number(r.earningsMicros ?? 0) / 1e6, fmt: (v) => formatMicros(Math.round(v * 1e6), currency) });
    if (audience !== 'publisher') list.splice(2, 0, { id: 'spend', label: 'Spend', get: (r) => Number(r.spendMicros ?? 0) / 1e6, fmt: (v) => formatMicros(Math.round(v * 1e6), currency) });
    if (audience !== 'publisher') list.push({ id: 'conversions', label: 'Conversions', get: (r) => r.conversions ?? 0, fmt: (v) => formatNumber(Math.round(v)) });
    return list;
  }, [audience, pub, currency]);
  const [metric, setMetric] = useState(metrics[0]!.id);
  const m = metrics.find((x) => x.id === metric) ?? metrics[0]!;
  const [compare, setCompare] = useState(true);
  // The previous period day by day, aligned to this period's first day.
  const prevSeries = compare ? a.previousTrend.map(m.get) : null;

  if (empty) {
    return <>{live}<Card><EmptyState title="No traffic recorded in this period">Analytics appear once validated events are recorded. Zero means nothing was recorded, not that data is missing.</EmptyState></Card></>;
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {audience !== 'publisher' && <KpiTile label="Spend" value={money(t.spendMicros)} delta={<Delta now={num(t.spendMicros)} before={num(p.spendMicros)} />} spark={spark('spendMicros')} definition={a.definitions.spend} />}
        {audience !== 'advertiser' && <KpiTile label={pub ? 'Estimated earnings' : 'Publisher earnings'} value={money(t.earningsMicros)} delta={<Delta now={num(t.earningsMicros)} before={num(p.earningsMicros)} />} spark={spark('earningsMicros')} definition={a.definitions.estimatedEarnings} />}
        {audience === 'admin' && <KpiTile label="Network revenue" value={money(t.networkRevenueMicros)} delta={<Delta now={num(t.networkRevenueMicros)} before={num(p.networkRevenueMicros)} />} spark={spark('networkRevenueMicros')} definition="Spend minus publisher earnings." />}
        <KpiTile label="Valid impressions" value={formatNumber(t.validImpressions)} delta={<Delta now={t.validImpressions} before={p.validImpressions} />} spark={spark('validImpressions')} definition={a.definitions.validImpressions} />
        <KpiTile label="Valid clicks" value={formatNumber(t.validClicks)} delta={<Delta now={t.validClicks} before={p.validClicks} />} spark={spark('validClicks')} definition={a.definitions.validClicks} />
        <KpiTile label="CTR" value={formatPercent(t.ctr)} delta={<Delta now={t.ctr} before={p.ctr} />} spark={spark('ctr')} definition={a.definitions.ctr} />
        {pub
          ? <KpiTile label="RPM" value={money(t.rpmMicros)} delta={<Delta now={num(t.rpmMicros)} before={num(p.rpmMicros)} />} definition="Estimated earnings divided by valid impressions, multiplied by 1,000." />
          : <KpiTile label="eCPM" value={money(t.ecpmMicros)} delta={<Delta now={num(t.ecpmMicros)} before={num(p.ecpmMicros)} invert={audience === 'advertiser'} />} definition={a.definitions.ecpm} />}
        <KpiTile label="Viewability" value={formatPercent(t.viewabilityRate, 1)} delta={<Delta now={t.viewabilityRate} before={p.viewabilityRate} />} spark={spark('viewabilityRate')} definition={a.definitions.viewabilityRate} />
        <KpiTile label="Avg. time in view" value={t.avgTimeInViewSec === null ? '—' : `${t.avgTimeInViewSec.toFixed(1)} s`} delta={<Delta now={t.avgTimeInViewSec} before={p.avgTimeInViewSec} />} definition={a.definitions.avgTimeInView} />
        {audience !== 'publisher' && <KpiTile label="Conversions" value={formatNumber(t.conversions)} delta={<Delta now={t.conversions} before={p.conversions} />} spark={spark('conversions')} definition={a.definitions.conversions} />}
        {audience !== 'publisher' && <KpiTile label="CPA" value={money(t.cpaMicros)} delta={<Delta now={num(t.cpaMicros)} before={num(p.cpaMicros)} invert />} definition={a.definitions.cpa} />}
        {audience !== 'publisher' && <KpiTile label="ROAS" value={t.roas === null ? '—' : `${t.roas.toFixed(2)}x`} delta={<Delta now={t.roas} before={p.roas} />} definition={a.definitions.roas} />}
        {a.traffic && <KpiTile label="Sessions" value={formatNumber(a.traffic.sessions)} delta={<span className="text-xs text-muted">{a.traffic.pagesPerSession ? `${a.traffic.pagesPerSession.toFixed(2)} pages per session` : ''}</span>} spark={a.traffic.trend.map((r) => r.sessions)} definition={a.definitions.sessions} />}
        {a.traffic && <KpiTile label="Session RPM" value={money(a.traffic.sessionRpmMicros)} delta={<span className="text-xs text-muted">Page RPM {money(a.traffic.pageRpmMicros)}</span>} definition={a.definitions.sessionRpm} />}
        <KpiTile label="Invalid traffic" value={formatPercent(t.invalidRate, 1)} delta={<Delta now={t.invalidRate} before={p.invalidRate} invert />} definition={a.definitions.invalidImpressions} />
      </div>

      {live}

      {a.insights.length > 0 && (
        <Card>
          <CardHeader title={<span className="inline-flex items-center gap-2"><Sparkles className="size-4 text-primary" aria-hidden /> Insights</span>} description="Fixed rules applied to this period's numbers. Each says what it is based on." />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {a.insights.map((i) => {
              const Icon = i.tone === 'warn' ? AlertTriangle : i.tone === 'good' ? TrendingUp : Info;
              return (
                <div key={i.title} className="flex gap-3 rounded-lg border border-border bg-surface-2/50 p-3">
                  <Icon className={cn('mt-0.5 size-4 shrink-0', i.tone === 'warn' ? 'text-warning' : i.tone === 'good' ? 'text-success' : 'text-primary')} aria-hidden />
                  <div><div className="text-sm font-medium text-fg">{i.title}</div><div className="mt-0.5 text-[13px] text-muted">{i.detail}</div></div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Performance over time" description={compare ? `Dashed line: the previous ${a.range.days} days, day by day.` : 'Daily values for the selected metric.'} actions={
          <>
            <label className="flex items-center gap-2 text-[13px] text-fg-2"><input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} className="size-4 accent-[var(--primary)]" /> Compare</label>
            <Select aria-label="Metric" value={metric} onChange={(e) => setMetric(e.target.value)}>{metrics.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>
          </>
        } />
        <PeriodChart days={a.trend.map((r) => r.key)} current={a.trend.map(m.get)} previous={prevSeries} label={m.label} format={m.fmt} />
      </Card>

      <CountriesCard a={a} currency={currency} audience={audience} />

      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader title="Delivery funnel" description="Each step with its share of the step before." />
          <Funnel steps={a.funnel} />
          {a.requests && <p className="mt-4 text-xs text-muted">Fill rate {formatPercent(a.requests.fillRate, 1)}. Requests without an ad: {formatNumber(a.requests.noFill)} no eligible ad, {formatNumber(a.requests.capRejects)} frequency cap, {formatNumber(a.requests.budgetRejects)} budget or pacing, {formatNumber(a.requests.blocked)} blocked.</p>}
        </Card>
        <HeatmapCard a={a} currency={currency} />
      </div>

      <Breakdowns a={a} currency={currency} audience={audience} />

      <div className="grid gap-5 xl:grid-cols-2">
        {a.traffic ? <TrafficCard a={a} currency={currency} /> : <ConversionCard a={a} currency={currency} />}
        <QualityCard a={a} />
      </div>
      {audience === 'admin' && <ConversionCard a={a} currency={currency} />}

      <PlacementsCard a={a} currency={currency} audience={audience} />
    </>
  );
}

function HeatmapCard({ a, currency }: { a: Analytics; currency: string }) {
  const [metric, setMetric] = useState('validImpressions');
  const fmt = metric === 'micros' ? (v: number) => formatMicros(v, currency) : (v: number) => formatNumber(v);
  return (
    <Card className="min-w-0">
      <CardHeader title="When it happens" description="Weekday by hour of day, summed over the period." actions={
        <Select aria-label="Heatmap metric" value={metric} onChange={(e) => setMetric(e.target.value)}>
          <option value="validImpressions">Valid impressions</option>
          <option value="validClicks">Valid clicks</option>
          <option value="viewableImpressions">Viewable impressions</option>
          <option value="micros">{a.heatmap.money === 'earnings' ? 'Estimated earnings' : 'Spend'}</option>
        </Select>
      } />
      <Heatmap cells={a.heatmap.cells} metric={metric} format={fmt} />
    </Card>
  );
}

const DIM_TABS: Record<Audience, Array<[string, string]>> = {
  advertiser: [['campaign', 'Campaigns'], ['creative', 'Creatives'], ['site', 'Publisher sites'], ['device', 'Devices'], ['os', 'Operating systems'], ['browser', 'Browsers'], ['country', 'Countries'], ['source', 'Traffic sources'], ['display', 'Placement types'], ['format', 'Ad formats']],
  publisher: [['site', 'Websites'], ['unit', 'Placements'], ['device', 'Devices'], ['os', 'Operating systems'], ['browser', 'Browsers'], ['country', 'Countries'], ['source', 'Traffic sources'], ['display', 'Placement types'], ['format', 'Ad formats']],
  admin: [['publisher', 'Publishers'], ['advertiser', 'Advertisers'], ['site', 'Sites'], ['campaign', 'Campaigns'], ['device', 'Devices'], ['os', 'Operating systems'], ['browser', 'Browsers'], ['country', 'Countries'], ['source', 'Traffic sources'], ['display', 'Placement types'], ['format', 'Ad formats']],
};

function Breakdowns({ a, currency, audience }: { a: Analytics; currency: string; audience: Audience }) {
  const tabs = DIM_TABS[audience].filter(([k]) => a.breakdowns[k]);
  const [dim, setDim] = useState(tabs.find(([k]) => k === 'device')?.[0] ?? tabs[0]![0]);
  const rows: Row[] = (a.breakdowns[dim] ?? []).map((r) => ({ ...r, label: dimLabel(dim, r.key, r.label) }));
  const money = (v: unknown) => formatMicros(v as string, currency);
  const pub = audience === 'publisher';
  const columns: Column<Row>[] = [
    { key: 'label', header: tabs.find(([k]) => k === dim)?.[1] ?? 'Item', cell: (r) => <span className="font-medium text-fg">{r.label}</span> },
    { key: 'imps', header: 'Valid impr.', align: 'right', cell: (r) => formatNumber(r.validImpressions) },
    { key: 'clicks', header: 'Valid clicks', align: 'right', cell: (r) => formatNumber(r.validClicks) },
    { key: 'ctr', header: 'CTR', align: 'right', cell: (r) => formatPercent(r.ctr) },
    { key: 'view', header: 'Viewability', align: 'right', cell: (r) => formatPercent(r.viewabilityRate, 1) },
    ...(audience !== 'publisher' ? [
      { key: 'spend', header: 'Spend', align: 'right' as const, cell: (r: Row) => money(r.spendMicros) },
      { key: 'ecpm', header: 'eCPM', align: 'right' as const, cell: (r: Row) => money(r.ecpmMicros) },
      { key: 'conv', header: 'Conv.', align: 'right' as const, cell: (r: Row) => formatNumber(r.conversions) },
      { key: 'cpa', header: 'CPA', align: 'right' as const, cell: (r: Row) => money(r.cpaMicros) },
    ] : []),
    ...(audience !== 'advertiser' ? [
      { key: 'earn', header: pub ? 'Est. earnings' : 'Pub. earnings', align: 'right' as const, cell: (r: Row) => money(r.earningsMicros) },
      { key: 'rpm', header: 'RPM', align: 'right' as const, cell: (r: Row) => money(r.rpmMicros) },
    ] : []),
  ];
  return (
    <Card>
      <CardHeader title="Breakdown" description="Who, where and on what. CTR and cost metrics are computed from each row's summed counts." />
      <Tabs tabs={tabs.map(([id, label]) => ({ id, label }))} active={dim} onChange={setDim} />
      <div className="grid gap-6 lg:grid-cols-[minmax(240px,320px)_1fr]">
        <ShareBars rows={rows.slice(0, 8).map((r) => ({ key: r.key, label: r.label, value: r.validImpressions ?? 0 }))} />
        <Table columns={columns} rows={rows} rowKey={(r) => r.key} empty={<EmptyState title="Nothing recorded in this period" />} />
      </div>
    </Card>
  );
}

type CountryMetric = { id: string; label: string; get: (r: Row) => number | null; fmt: (v: number) => string };

/**
 * The country report: a world map shaded by the chosen metric, the selected
 * or leading countries beside it, and every country in a sortable table with
 * the change in valid impressions from the previous period.
 */
function CountriesCard({ a, currency, audience }: { a: Analytics; currency: string; audience: Audience }) {
  const pub = audience === 'publisher';
  const moneyFmt = (v: number) => formatMicros(Math.round(v), currency);
  const micros = (k: string) => (r: Row) => (r[k] === null || r[k] === undefined ? null : Number(r[k]));
  const metrics: CountryMetric[] = useMemo(() => {
    const list: CountryMetric[] = [
      { id: 'imps', label: 'Valid impressions', get: (r) => r.validImpressions ?? 0, fmt: (v) => formatNumber(v) },
      { id: 'clicks', label: 'Valid clicks', get: (r) => r.validClicks ?? 0, fmt: (v) => formatNumber(v) },
      { id: 'ctr', label: 'CTR', get: (r) => r.ctr ?? null, fmt: (v) => formatPercent(v) },
      { id: 'view', label: 'Viewability', get: (r) => r.viewabilityRate ?? null, fmt: (v) => formatPercent(v, 1) },
    ];
    if (audience !== 'advertiser') {
      list.unshift({ id: 'pv', label: 'Page views', get: (r) => r.pageviews ?? 0, fmt: (v) => formatNumber(v) });
      list.splice(1, 0, { id: 'earn', label: pub ? 'Estimated earnings' : 'Publisher earnings', get: micros('earningsMicros'), fmt: moneyFmt },
        { id: 'prpm', label: 'Page RPM', get: micros('pageRpmMicros'), fmt: moneyFmt },
        { id: 'rpm', label: 'Impression RPM', get: micros('rpmMicros'), fmt: moneyFmt });
    }
    if (audience !== 'publisher') {
      list.splice(audience === 'admin' ? 4 : 0, 0, { id: 'spend', label: 'Spend', get: micros('spendMicros'), fmt: moneyFmt },
        { id: 'ecpm', label: 'eCPM', get: micros('ecpmMicros'), fmt: moneyFmt });
      list.push({ id: 'conv', label: 'Conversions', get: (r) => r.conversions ?? 0, fmt: (v) => formatNumber(v) },
        { id: 'cpa', label: 'CPA', get: micros('cpaMicros'), fmt: moneyFmt });
    }
    return list;
  }, [audience, pub, currency]); // eslint-disable-line react-hooks/exhaustive-deps
  const [metricId, setMetricId] = useState(metrics[0]!.id);
  const metric = metrics.find((m) => m.id === metricId) ?? metrics[0]!;
  const [sort, setSort] = useState<{ id: string; desc: boolean }>({ id: metrics[0]!.id, desc: true });
  const [selected, setSelected] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  const rows: Row[] = a.countries.rows.map((r) => ({ ...r, label: countryName(r.key) }));
  const values = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) { const v = metric.get(r); if (r.key !== 'ZZ' && v !== null && v > 0) m.set(r.key, v); }
    return m;
  }, [rows, metric]); // eslint-disable-line react-hooks/exhaustive-deps
  const sortBy = sort.id === 'country' ? null : metrics.find((m) => m.id === sort.id) ?? (sort.id === 'change' ? null : metric);
  const change = (r: Row) => (r.previousValidImpressions ? ((r.validImpressions - r.previousValidImpressions) / r.previousValidImpressions) * 100 : null);
  const sorted = [...rows].sort((x, y) => {
    if (sort.id === 'country') return (sort.desc ? -1 : 1) * x.label.localeCompare(y.label);
    const vx = sort.id === 'change' ? change(x) : sortBy!.get(x);
    const vy = sort.id === 'change' ? change(y) : sortBy!.get(y);
    if (vx === null && vy === null) return 0;
    if (vx === null) return 1;
    if (vy === null) return -1;
    return sort.desc ? vy - vx : vx - vy;
  });
  const shown = all ? sorted : sorted.slice(0, 15);
  const header = (id: string, label: string) => (
    <button className={cn('inline-flex items-center gap-1 uppercase hover:text-fg', sort.id === id && 'text-fg')} onClick={() => setSort({ id, desc: sort.id === id ? !sort.desc : id !== 'country' })}>
      {label}{sort.id === id && <span aria-hidden>{sort.desc ? '↓' : '↑'}</span>}
    </button>
  );
  const col = (id: string, label: string): Column<Row> => {
    const m = metrics.find((x) => x.id === id)!;
    return { key: id, header: header(id, label), align: 'right', cell: (r) => { const v = m.get(r); return v === null ? '—' : m.fmt(v); } };
  };
  const columns: Column<Row>[] = [
    { key: 'country', header: header('country', 'Country'), cell: (r) => (
      <button className={cn('inline-flex items-center gap-2 whitespace-nowrap text-left font-medium text-fg hover:underline', selected === r.key && 'text-primary')} onClick={() => setSelected(selected === r.key ? null : r.key)}>
        <span className="inline-flex h-5 w-7 shrink-0 items-center justify-center rounded bg-surface-2 text-[10px] font-semibold text-muted">{r.key === 'ZZ' ? '??' : r.key}</span>{r.label}
      </button>
    ) },
    ...(audience !== 'advertiser' ? [col('pv', 'Page views'), { key: 'sess', header: 'Sessions', align: 'right' as const, cell: (r: Row) => formatNumber(r.sessions) }] : []),
    col('imps', 'Valid impr.'),
    { key: 'share', header: 'Share', align: 'right', cell: (r) => formatPercent(r.share, 1) },
    col('clicks', 'Clicks'),
    col('ctr', 'CTR'),
    col('view', 'Viewability'),
    ...(audience !== 'publisher' ? [col('spend', 'Spend'), col('ecpm', 'eCPM'), col('conv', 'Conv.'), col('cpa', 'CPA')] : []),
    ...(audience !== 'advertiser' ? [col('earn', pub ? 'Est. earnings' : 'Pub. earnings'), col('prpm', 'Page RPM'), col('rpm', 'Impr. RPM')] : []),
    { key: 'change', header: header('change', 'vs prev.'), align: 'right', cell: (r) => <Delta now={r.validImpressions} before={r.previousValidImpressions} compact /> },
  ];

  const focus = selected ? rows.find((r) => r.key === selected) : null;
  const leaders = [...rows].filter((r) => r.key !== 'ZZ').sort((x, y) => (metric.get(y) ?? -1) - (metric.get(x) ?? -1)).slice(0, 8);
  return (
    <Card>
      <CardHeader title="Countries" description={`Where your ${audience === 'advertiser' ? 'ads were seen' : 'visitors and ad revenue came from'}: ${formatNumber(a.countries.count)} countries in this period, from the visitor's IP at the time of the event (the IP itself is not stored).`} actions={
        <Select aria-label="Map metric" value={metricId} onChange={(e) => setMetricId(e.target.value)}>{metrics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</Select>
      } />
      {rows.length === 0 ? <EmptyState title="Nothing recorded in this period" /> : (
        <>
          <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
            <div className="min-w-0"><CountryMap values={values} format={metric.fmt} label={metric.label} selected={selected} onSelect={setSelected} /></div>
            <div>
              {focus ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between"><div className="text-sm font-semibold text-fg">{focus.label}</div><button className="text-xs font-medium text-primary hover:underline" onClick={() => setSelected(null)}>Clear</button></div>
                  <div className="grid grid-cols-2 gap-2">
                    {metrics.map((m) => { const v = m.get(focus); return <Fact key={m.id} label={m.label} value={v === null ? '—' : m.fmt(v)} />; })}
                    <Fact label="Share of impressions" value={formatPercent(focus.share, 1)} />
                    <Fact label="vs previous period" value={<Delta now={focus.validImpressions} before={focus.previousValidImpressions} />} />
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Top countries by {metric.label.toLowerCase()}</div>
                  <ul className="space-y-1.5 text-sm">
                    {leaders.map((r, i) => {
                      const v = metric.get(r);
                      return (
                        <li key={r.key}>
                          <button className="flex w-full justify-between gap-3 text-left hover:text-fg" onClick={() => setSelected(r.key)}>
                            <span className="truncate text-fg-2"><span className="tabular mr-2 text-muted">{i + 1}</span>{r.label}</span>
                            <span className="tabular text-fg">{v === null ? '—' : metric.fmt(v)}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-3 text-[11px] text-muted">Select a country on the map or in the table for its full numbers.</p>
                </>
              )}
            </div>
          </div>
          <div className="mt-5">
            <Table columns={columns} rows={shown} rowKey={(r) => r.key} />
            {sorted.length > 15 && (
              <button className="mt-3 text-sm font-medium text-primary hover:underline" onClick={() => setAll(!all)}>{all ? 'Show top 15' : `Show all ${sorted.length} countries`}</button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function TrafficCard({ a, currency }: { a: Analytics; currency: string }) {
  const tr = a.traffic!;
  const money = (v: unknown) => formatMicros(v as string, currency);
  return (
    <Card className="min-w-0">
      <CardHeader title="Traffic and sessions" description="Page views and sessions by where visitors came from, with what each source earns." />
      <Table
        rows={tr.bySource.map((r) => ({ ...r, key: String(r.source) }) as Row)}
        rowKey={(r) => r.key}
        columns={[
          { key: 'src', header: 'Source', cell: (r) => <span className="font-medium text-fg">{dimLabel('source', r.source)}</span> },
          { key: 'pv', header: 'Page views', align: 'right', cell: (r) => formatNumber(r.pageviews) },
          { key: 's', header: 'Sessions', align: 'right', cell: (r) => formatNumber(r.sessions) },
          { key: 'e', header: 'Est. earnings', align: 'right', cell: (r) => money(r.earningsMicros) },
          { key: 'prpm', header: 'Page RPM', align: 'right', cell: (r) => money(r.pageRpmMicros) },
          { key: 'srpm', header: 'Session RPM', align: 'right', cell: (r) => money(r.sessionRpmMicros) },
        ]}
        empty={<EmptyState title="No page views recorded in this period" />}
      />
      <p className="mt-3 text-xs text-muted">Sessions start on a page reached from outside the site or with no referrer; no cookies or device storage are used to count them. Internal navigation adds page views, not sessions.</p>
    </Card>
  );
}

function ConversionCard({ a, currency }: { a: Analytics; currency: string }) {
  const t = a.totals;
  const money = (v: unknown) => formatMicros(v as string, currency);
  const events = a.conversionEvents ?? [];
  return (
    <Card className="min-w-0">
      <CardHeader title="Conversions" description="Reported by the advertiser's pixel or postback for valid clicks, inside each campaign's attribution window." />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Conversion rate" value={formatPercent(t.conversionRate)} />
        <Fact label="Conversion value" value={money(t.conversionValueMicros)} />
        <Fact label="Reach" value={a.reach?.available ? formatNumber(a.reach.reach) : '—'} hint={a.reach?.available ? 'consenting visitors' : `ranges up to ${a.reach?.maxDays ?? 92} days`} />
        <Fact label="Frequency" value={a.reach?.available && a.reach.frequency ? a.reach.frequency.toFixed(2) : '—'} hint="impressions per visitor" />
      </div>
      <Table
        rows={events.map((e) => ({ ...e, key: e.event }))}
        rowKey={(r) => r.key}
        columns={[
          { key: 'ev', header: 'Event', cell: (r) => <span className="font-medium text-fg">{r.event}</span> },
          { key: 'n', header: 'Conversions', align: 'right', cell: (r) => formatNumber(r.conversions) },
          { key: 'v', header: 'Value', align: 'right', cell: (r) => money(r.valueMicros) },
          { key: 'lag', header: 'Avg. time to convert', align: 'right', cell: (r) => (r.avgHoursToConvert === null ? '—' : r.avgHoursToConvert < 1 ? `${Math.round(r.avgHoursToConvert * 60)} min` : `${r.avgHoursToConvert.toFixed(1)} h`) },
        ]}
        empty={<EmptyState title="No conversions recorded">Turn on conversion tracking on a campaign, then add the pixel or postback on your site.</EmptyState>}
      />
    </Card>
  );
}

function QualityCard({ a }: { a: Analytics }) {
  const t = a.totals;
  const quality = t.rendered ? (t.validImpressions / t.rendered) * 100 : null;
  return (
    <Card className="min-w-0">
      <CardHeader title="Traffic quality" description="Events the invalid-traffic filters rejected, by reason. Rejected events are never billed or paid." />
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Fact label="Valid share of renders" value={formatPercent(quality, 1)} />
        <Fact label="Invalid impressions" value={formatNumber(t.invalidImpressions)} />
        <Fact label="Invalid clicks" value={formatNumber(t.invalidClicks)} />
      </div>
      <ShareBars rows={a.ivt.slice(0, 8).map((r) => ({ key: `${r.type}:${r.reason}`, label: `${IVT_REASONS[r.reason] ?? r.reason} · ${IVT_TYPES[r.type] ?? r.type}`, value: r.events }))} />
    </Card>
  );
}

function PlacementsCard({ a, currency, audience }: { a: Analytics; currency: string; audience: Audience }) {
  const money = (v: unknown) => formatMicros(v as string, currency);
  return (
    <Card>
      <CardHeader title="Placement viewability" description="IAB/MRC standard: at least 50% of the ad in view for one continuous second. Time in view is reported when the visitor leaves the page." />
      <Table
        rows={a.placements}
        rowKey={(r) => r.key}
        columns={[
          { key: 'u', header: 'Placement', cell: (r) => <span className="font-medium text-fg">{r.label}</span> },
          { key: 'i', header: 'Valid impr.', align: 'right', cell: (r) => formatNumber(r.validImpressions) },
          { key: 'v', header: 'Viewability', align: 'right', cell: (r) => <ViewBar pct={r.viewabilityRate} /> },
          { key: 't', header: 'Avg. time in view', align: 'right', cell: (r) => (r.avgTimeInViewSec === null ? '—' : `${r.avgTimeInViewSec.toFixed(1)} s`) },
          { key: 'c', header: 'CTR', align: 'right', cell: (r) => formatPercent(r.ctr) },
          audience === 'advertiser'
            ? { key: 'm', header: 'eCPM', align: 'right', cell: (r) => money(r.ecpmMicros) }
            : { key: 'm', header: 'RPM', align: 'right', cell: (r) => money(r.rpmMicros) },
        ]}
        empty={<EmptyState title="No placements delivered in this period" />}
      />
    </Card>
  );
}

function ViewBar({ pct }: { pct: number | null }) {
  if (pct === null || pct === undefined) return <>—</>;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="hidden h-1.5 w-16 rounded-full bg-surface-2 sm:inline-block"><span className="block h-1.5 rounded-full" style={{ width: `${Math.min(100, pct)}%`, background: pct < 50 ? 'var(--warning)' : 'var(--chart-3)' }} /></span>
      {formatPercent(pct, 1)}
    </span>
  );
}

function Fact({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg bg-surface-2/70 px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="tabular text-lg font-semibold text-fg">{value}</div>
      {hint && <div className="text-[10px] text-muted">{hint}</div>}
    </div>
  );
}

