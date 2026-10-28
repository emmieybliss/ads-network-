'use client';
import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Async, Button, Card, CardHeader, EmptyState, Field, Input, Select, Stat, Table, type Column } from './ui';
import { TrendChart } from './charts';
import { dimLabel } from './analytics/parts';
import { useApi } from '@/lib/hooks';
import { qs } from '@/lib/api';
import { formatMicros, formatNumber, formatPercent, isoDay } from '@/lib/format';

type Row = Record<string, any> & { key: string; label: string };

const GROUPS = {
  advertiser: [['day', 'Date'], ['campaign', 'Campaign'], ['creative', 'Creative'], ['site', 'Publisher site'], ['unit', 'Placement'], ['device', 'Device'], ['country', 'Country'], ['os', 'Operating system'], ['browser', 'Browser'], ['source', 'Traffic source'], ['display', 'Placement type'], ['format', 'Ad format']],
  publisher: [['day', 'Date'], ['site', 'Website'], ['unit', 'Placement'], ['device', 'Device'], ['country', 'Country'], ['os', 'Operating system'], ['browser', 'Browser'], ['source', 'Traffic source'], ['display', 'Placement type'], ['format', 'Ad format']],
} as const;

export function defaultRange(days = 30) {
  const to = new Date();
  const from = new Date(Date.now() - (days - 1) * 86_400_000);
  return { from: isoDay(from), to: isoDay(to) };
}

/**
 * Report view for an organization: date range, grouping, totals, trend and a
 * table, all computed by the API from validated events. CSV export uses the
 * same query.
 */
export function ReportExplorer({ orgId, audience, currency, filters = {} }: { orgId: string; audience: 'advertiser' | 'publisher'; currency: string; filters?: Record<string, string | undefined> }) {
  const [range, setRange] = useState(defaultRange());
  const [groupBy, setGroupBy] = useState('day');
  const query = qs({ ...range, groupBy, ...filters });
  const res = useApi<{ data: { totals: Record<string, any>; rows: Row[]; requests?: Record<string, number | null>; definitions: Record<string, string> } }>(`/orgs/${orgId}/reports${query}`);
  const money = (v: unknown) => formatMicros(v as string, currency);
  const adv = audience === 'advertiser';

  const columns = useMemo<Column<Row>[]>(() => [
    { key: 'label', header: GROUPS[audience].find(([g]) => g === groupBy)?.[1] ?? 'Item', cell: (r) => <span className="font-medium text-fg">{dimLabel(groupBy, r.key, r.label)}</span> },
    { key: 'served', header: 'Served', align: 'right', cell: (r) => formatNumber(r.served) },
    { key: 'valid', header: 'Valid impr.', align: 'right', cell: (r) => formatNumber(r.validImpressions) },
    { key: 'viewable', header: 'Viewable', align: 'right', cell: (r) => formatNumber(r.viewableImpressions) },
    { key: 'invalid', header: 'Invalid', align: 'right', cell: (r) => formatNumber(r.invalidImpressions) },
    { key: 'clicks', header: 'Valid clicks', align: 'right', cell: (r) => formatNumber(r.validClicks) },
    { key: 'ctr', header: 'CTR', align: 'right', cell: (r) => formatPercent(r.ctr) },
    ...(adv
      ? [
          { key: 'spend', header: 'Spend', align: 'right' as const, cell: (r: Row) => money(r.spendMicros) },
          { key: 'ecpm', header: 'eCPM', align: 'right' as const, cell: (r: Row) => money(r.ecpmMicros) },
          { key: 'ecpc', header: 'eCPC', align: 'right' as const, cell: (r: Row) => money(r.ecpcMicros) },
          { key: 'conv', header: 'Conv.', align: 'right' as const, cell: (r: Row) => formatNumber(r.conversions) },
          { key: 'cpa', header: 'CPA', align: 'right' as const, cell: (r: Row) => money(r.cpaMicros) },
        ]
      : [
          { key: 'earn', header: 'Est. earnings', align: 'right' as const, cell: (r: Row) => money(r.earningsMicros) },
          { key: 'rpm', header: 'RPM', align: 'right' as const, cell: (r: Row) => money(r.rpmMicros) },
        ]),
  ], [audience, groupBy, adv, currency]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From" htmlFor="from"><Input id="from" type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
          <Field label="To" htmlFor="to"><Input id="to" type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          <Field label="Group by" htmlFor="gb">
            <Select id="gb" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              {GROUPS[audience].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <div className="flex gap-2">
            {[7, 30, 90].map((d) => <Button key={d} variant="secondary" size="sm" onClick={() => setRange(defaultRange(d))}>{d} days</Button>)}
          </div>
          <a href={`/api/v1/orgs/${orgId}/reports/export${query}`} className="ml-auto inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3.5 text-sm font-medium shadow-sm hover:bg-surface-2">
            <Download className="size-4" aria-hidden /> Export CSV
          </a>
        </div>
      </Card>
      <Async res={res}>
        {({ data }) => {
          const t = data.totals;
          const empty = (t.served ?? 0) === 0 && (t.validImpressions ?? 0) === 0;
          return (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
                <Stat label="Valid impressions" value={formatNumber(t.validImpressions)} definition={data.definitions.validImpressions} />
                <Stat label="Viewable" value={formatNumber(t.viewableImpressions)} hint={t.viewabilityRate !== null ? `${formatPercent(t.viewabilityRate, 1)} of valid` : undefined} definition={data.definitions.viewableImpressions} />
                <Stat label="Valid clicks" value={formatNumber(t.validClicks)} definition={data.definitions.validClicks} />
                <Stat label="CTR" value={formatPercent(t.ctr)} definition={data.definitions.ctr} />
                {adv ? (
                  <>
                    <Stat label="Spend" value={money(t.spendMicros)} definition={data.definitions.spend} />
                    <Stat label="eCPM" value={money(t.ecpmMicros)} definition={data.definitions.ecpm} />
                  </>
                ) : (
                  <>
                    <Stat label="Estimated earnings" value={money(t.earningsMicros)} definition={data.definitions.estimatedEarnings} />
                    <Stat label="RPM" value={money(t.rpmMicros)} definition="Estimated earnings divided by valid impressions, multiplied by 1,000." />
                  </>
                )}
              </div>
              {data.requests && (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Stat label="Ad requests" value={formatNumber(data.requests.requests)} definition="Placement requests received from your pages." />
                  <Stat label="Filled" value={formatNumber(data.requests.filled)} hint={data.requests.fillRate !== null ? `${formatPercent(data.requests.fillRate, 1)} fill rate` : undefined} />
                  <Stat label="No eligible ad" value={formatNumber(data.requests.noFill)} />
                  <Stat label="Invalid impressions" value={formatNumber(t.invalidImpressions)} definition={data.definitions.invalidImpressions} />
                </div>
              )}
              {empty ? (
                <Card><EmptyState title="No traffic recorded in this period">Numbers appear here once validated events are recorded. Zero means nothing was recorded, not that data is missing.</EmptyState></Card>
              ) : (
                <>
                  {groupBy === 'day' && (
                    <Card>
                      <CardHeader title="Daily trend" description="Valid impressions and valid clicks." />
                      <TrendChart data={data.rows} series={[{ key: 'validImpressions', label: 'Valid impressions', color: 'var(--chart-1)' }, { key: 'validClicks', label: 'Valid clicks', color: 'var(--chart-2)' }]} />
                    </Card>
                  )}
                  <Card>
                    <CardHeader title="Breakdown" description="CTR and cost metrics are computed from the summed counts in each row." />
                    <Table columns={columns} rows={data.rows} rowKey={(r) => r.key} />
                  </Card>
                </>
              )}
            </>
          );
        }}
      </Async>
    </div>
  );
}
