'use client';
import { useState } from 'react';
import { Download } from 'lucide-react';
import { Async, Button, Card, CardHeader, EmptyState, Field, Input, Stat, Table, type Column } from '@/components/ui';
import { defaultRange } from '@/components/ReportExplorer';
import { useApi } from '@/lib/hooks';
import { qs } from '@/lib/api';
import { formatMicros, formatNumber, formatPercent } from '@/lib/format';

type PageRow = { siteId: string; domain: string; path: string; pageviews: number; validImpressions: number; validClicks: number; ctr: number | null; impressionsPerPageview: number | null; earningsMicros: string; pageRpmMicros: string | null };

const PAGE_RPM = 'Estimated earnings divided by page views, multiplied by 1,000. A page view is a page where the ad tag asked for at least one ad.';

/** Per-page report: which pages earn, with page views and page RPM. */
export function PageReport({ orgId, currency, siteId }: { orgId: string; currency: string; siteId?: string }) {
  const [range, setRange] = useState(defaultRange());
  const query = qs({ ...range, siteId });
  const res = useApi<{ data: { totals: Omit<PageRow, 'siteId' | 'domain' | 'path'>; rows: PageRow[] } }>(`/orgs/${orgId}/reports/pages${query}`);
  const money = (v: string | null | undefined) => formatMicros(v, currency);
  const columns: Column<PageRow>[] = [
    { key: 'page', header: 'Page', cell: (r) => <span className="block max-w-[340px] truncate font-medium text-fg" title={`${r.domain}${r.path}`}><span className="text-muted">{r.domain}</span>{r.path}</span> },
    { key: 'pv', header: 'Page views', align: 'right', cell: (r) => formatNumber(r.pageviews) },
    { key: 'imp', header: 'Valid impr.', align: 'right', cell: (r) => formatNumber(r.validImpressions) },
    { key: 'ipp', header: 'Impr. / page view', align: 'right', cell: (r) => (r.impressionsPerPageview == null ? '—' : r.impressionsPerPageview.toFixed(2)) },
    { key: 'clicks', header: 'Valid clicks', align: 'right', cell: (r) => formatNumber(r.validClicks) },
    { key: 'ctr', header: 'CTR', align: 'right', cell: (r) => formatPercent(r.ctr) },
    { key: 'earn', header: 'Est. earnings', align: 'right', cell: (r) => money(r.earningsMicros) },
    { key: 'rpm', header: 'Page RPM', align: 'right', cell: (r) => money(r.pageRpmMicros) },
  ];
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Pages" description="Earnings by page. The path is stored without the query string or fragment." actions={
          <a href={`/api/v1/orgs/${orgId}/reports/pages/export${query}`} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3.5 text-sm font-medium shadow-sm hover:bg-surface-2">
            <Download className="size-4" aria-hidden /> Export CSV
          </a>
        } />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="From" htmlFor="pfrom"><Input id="pfrom" type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
          <Field label="To" htmlFor="pto"><Input id="pto" type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          <div className="flex gap-2">
            {[7, 30, 90].map((d) => <Button key={d} variant="secondary" size="sm" onClick={() => setRange(defaultRange(d))}>{d} days</Button>)}
          </div>
        </div>
      </Card>
      <Async res={res}>
        {({ data }) => (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Page views" value={formatNumber(data.totals.pageviews)} definition="Pages where the ad tag asked for at least one ad, counted once per page view." />
              <Stat label="Page RPM" value={money(data.totals.pageRpmMicros)} definition={PAGE_RPM} />
              <Stat label="Impressions per page view" value={data.totals.impressionsPerPageview == null ? '—' : data.totals.impressionsPerPageview.toFixed(2)} />
              <Stat label="Estimated earnings" value={money(data.totals.earningsMicros)} />
            </div>
            <Card>
              {data.rows.length === 0
                ? <EmptyState title="No page data in this period">Pages appear once the ad tag has requested ads on them.</EmptyState>
                : <Table columns={columns} rows={data.rows} rowKey={(r) => `${r.siteId}${r.path}`} />}
            </Card>
          </>
        )}
      </Async>
    </div>
  );
}
