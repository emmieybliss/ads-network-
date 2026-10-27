'use client';
import Link from 'next/link';
import { Async, Badge, Card, CardHeader, PageHeader, Stat } from '@/components/ui';
import { TrendChart } from '@/components/charts';
import { useApi } from '@/lib/hooks';
import { formatMicros, formatNumber, formatPercent } from '@/lib/format';

function Health({ h }: { h: any }) {
  const tone = (v: string) => (v === 'ok' ? 'success' : 'danger') as 'success' | 'danger';
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      <Badge tone={tone(h.database)}>Database {h.database}</Badge>
      <Badge tone={tone(h.redis)}>Redis {h.redis}</Badge>
      <Badge tone={h.worker?.healthy ? 'success' : 'warning'}>Worker {h.worker?.healthy ? 'healthy' : 'not reporting'}</Badge>
    </div>
  );
}

export default function AdminOverview() {
  const res = useApi<{ data: any }>('/admin/overview');
  return (
    <>
      <PageHeader title="Network overview" description="Last 30 days. All figures come from recorded, validated events in this installation." />
      <Async res={res}>
        {({ data: d }) => (
          <div className="space-y-5">
            <Card><CardHeader title="System health" actions={<Link className="text-sm text-primary hover:underline" href="/admin/system">Details</Link>} /><Health h={d.health} /></Card>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Link href="/admin/sites"><Stat label="Sites awaiting review" value={formatNumber(d.pendingReviews.sites)} /></Link>
              <Link href="/admin/campaigns"><Stat label="Campaigns awaiting review" value={formatNumber(d.campaigns.pending)} /></Link>
              <Link href="/admin/creatives"><Stat label="Creatives awaiting review" value={formatNumber(d.pendingReviews.creatives)} /></Link>
              <Link href="/admin/orgs"><Stat label="Organizations awaiting review" value={formatNumber(d.pendingReviews.orgs)} /></Link>
              <Link href="/admin/payouts"><Stat label="Payouts to process" value={formatNumber(d.pendingPayouts.n)} hint={formatMicros(d.pendingPayouts.total)} /></Link>
              <Link href="/admin/finance"><Stat label="Payments pending" value={formatNumber(d.pendingPayments.n)} hint={formatMicros(d.pendingPayments.total)} /></Link>
              <Link href="/admin/fraud"><Stat label="Open IVT cases" value={formatNumber(d.ivt.open_cases)} hint={`${d.ivt.alerts} unacknowledged alerts`} /></Link>
              <Stat label="Users" value={formatNumber(d.users.total)} hint={`${d.users.new30} new in 30 days`} />
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Valid impressions" value={formatNumber(d.validImpressions)} />
              <Stat label="Valid clicks" value={formatNumber(d.validClicks)} />
              <Stat label="CTR" value={formatPercent(d.ctr)} />
              <Stat label="Invalid rate" value={d.invalidRate == null ? '—' : formatPercent(d.invalidRate, 1)} definition="Invalid impressions divided by rendered impressions." />
              <Stat label="Advertiser spend" value={formatMicros(d.advertiserSpendMicros)} />
              <Stat label="Publisher earnings" value={formatMicros(d.publisherEarningsMicros)} />
              <Stat label="Network revenue" value={formatMicros(d.networkRevenueMicros)} definition="Spend minus publisher earnings, before fees and refunds." />
              <Stat label="Approved / verified sites" value={`${d.sites.approved} / ${d.sites.verified}`} hint={`${d.activeAdvertisers} advertisers with live campaigns`} />
            </div>
            <Card>
              <CardHeader title="Daily valid impressions and clicks" />
              {d.trend.length ? <TrendChart data={d.trend.map((t: any) => ({ label: t.day, imps: Number(t.imps), clicks: Number(t.clicks) }))} series={[{ key: 'imps', label: 'Valid impressions', color: 'var(--chart-1)' }, { key: 'clicks', label: 'Valid clicks', color: 'var(--chart-2)' }]} /> : <p className="text-sm text-muted">No traffic recorded in this period.</p>}
            </Card>
          </div>
        )}
      </Async>
    </>
  );
}
