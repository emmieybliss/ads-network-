'use client';
import { Card, CardHeader, EmptyState, Table, type Column } from '@/components/ui';
import { ShareBars } from '@/components/analytics/parts';
import { formatMicros, formatNumber, formatPercent } from '@/lib/format';
import { SAFETY_LEVEL_LABELS } from '@blissnova/shared';
import { SafetyBadge } from './TopicUi';

export interface TopicsData {
  rows: Array<Record<string, any> & { topic: string; label: string }>;
  safety: Array<{ level: string; pages: number; pageviews: number }> | null;
}

/**
 * Performance by page topic (the topic each ad's page had when it was served)
 * and, for publishers and staff, pages by brand-safety risk.
 */
export function TopicsCard({ data, currency, audience }: { data: TopicsData; currency: string; audience: 'advertiser' | 'publisher' | 'admin' }) {
  const money = (v: unknown) => formatMicros(v as string, currency);
  const pub = audience === 'publisher';
  const views = audience !== 'advertiser';
  type R = TopicsData['rows'][number];
  const columns: Column<R>[] = [
    { key: 'label', header: 'Topic', cell: (r) => <span className={r.topic ? 'font-medium text-fg' : 'text-muted'}>{r.label}</span> },
    ...(views ? [{ key: 'pv', header: 'Page views', align: 'right' as const, cell: (r: R) => (r.pageviews === undefined ? '—' : formatNumber(r.pageviews)) }] : []),
    { key: 'imps', header: 'Valid impr.', align: 'right', cell: (r) => formatNumber(r.validImpressions) },
    { key: 'share', header: 'Share', align: 'right', cell: (r) => formatPercent(r.share, 1) },
    { key: 'clicks', header: 'Valid clicks', align: 'right', cell: (r) => formatNumber(r.validClicks) },
    { key: 'ctr', header: 'CTR', align: 'right', cell: (r) => formatPercent(r.ctr) },
    pub
      ? { key: 'earn', header: 'Est. earnings', align: 'right', cell: (r) => money(r.earningsMicros) }
      : { key: 'spend', header: 'Spend', align: 'right', cell: (r) => money(r.spendMicros) },
    pub
      ? { key: 'rpm', header: 'Page RPM', align: 'right', cell: (r) => money(r.pageRpmMicros) }
      : { key: 'ecpm', header: 'eCPM', align: 'right', cell: (r) => money(r.ecpmMicros) },
  ];
  const description = audience === 'advertiser'
    ? 'What the pages your ads appeared on were about, detected automatically from each page\'s text when the ad was served.'
    : 'What your pages are about, detected automatically from their text, and how each topic earns. "Uncategorized" pages had too little text to judge or use a site category with no topic.';
  const totalPages = data.safety?.reduce((n, s) => n + s.pages, 0) ?? 0;
  return (
    <Card>
      <CardHeader title="Page topics" description={description} />
      {data.rows.length === 0 ? <EmptyState title="Nothing recorded in this period">Topics appear once ads have been served on classified pages.</EmptyState> : (
        <div className="grid gap-6 lg:grid-cols-[minmax(240px,320px)_1fr]">
          <ShareBars rows={data.rows.slice(0, 8).map((r) => ({ key: r.topic || 'none', label: r.label, value: r.validImpressions ?? 0 }))} />
          <Table columns={columns} rows={data.rows} rowKey={(r) => r.topic || 'none'} />
        </div>
      )}
      {data.safety && totalPages > 0 && (
        <div className="mt-5 border-t border-border pt-4">
          <div className="mb-2 text-sm font-medium text-fg">Brand safety of pages viewed in this period</div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {data.safety.map((s) => (
              <div key={s.level} className="flex items-center gap-2 text-sm">
                <SafetyBadge level={s.level} />
                <span className="text-fg-2">{formatNumber(s.pages)} {s.pages === 1 ? 'page' : 'pages'} · {formatNumber(s.pageviews)} views</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            Each campaign chooses which risk levels it accepts (most take safe and low-risk pages). {SAFETY_LEVEL_LABELS.high} pages show no ads at all.
          </p>
        </div>
      )}
    </Card>
  );
}
