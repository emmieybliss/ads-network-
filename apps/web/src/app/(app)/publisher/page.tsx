'use client';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Async, Card, CardHeader, EmptyState, LinkButton, PageHeader, Stat } from '@/components/ui';
import { BreakdownBars, TrendChart } from '@/components/charts';
import { useApi } from '@/lib/hooks';
import { useOrg } from '@/lib/session';
import { formatMicros, formatNumber, formatPercent, humanize } from '@/lib/format';

export default function PublisherOverview() {
  const org = useOrg();
  const res = useApi<{ data: any }>(`/orgs/${org.id}/dashboard`);
  const money = (v: string | null | undefined) => formatMicros(v, org.currency);
  return (
    <>
      <PageHeader title="Overview" description="Last 30 days across your websites. Earnings are estimates until settled and released after the hold period." actions={<LinkButton href="/publisher/sites/new"><Plus className="size-4" /> Add website</LinkButton>} />
      <Async res={res}>
        {({ data }) => {
          const t = data.totals;
          const sites = Object.entries(data.sites as Record<string, number>);
          const none = !t.validImpressions && !data.requests?.requests;
          return (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="Estimated earnings (30 days)" value={money(t.earningsMicros)} definition="Your share of valid billable events. Final amounts are confirmed at settlement and can be reduced if traffic is later found invalid." />
                <Stat label="Pending (in hold)" value={money(data.pendingMicros)} />
                <Stat label="Available for payout" value={money(data.availableMicros)} hint={<Link className="text-primary hover:underline" href="/publisher/earnings">Payouts</Link>} />
                <Stat label="RPM" value={money(t.rpmMicros)} definition="Estimated earnings per 1,000 valid impressions." />
                <Stat label="Ad requests" value={formatNumber(data.requests?.requests)} />
                <Stat label="Fill rate" value={data.requests?.fillRate == null ? '—' : formatPercent(data.requests.fillRate, 1)} definition="Requests that received an ad. Fill depends on advertiser demand and is never guaranteed." />
                <Stat label="Valid impressions" value={formatNumber(t.validImpressions)} />
                <Stat label="CTR" value={formatPercent(t.ctr)} />
              </div>
              {sites.length === 0 ? (
                <Card><EmptyState title="Add your first website" action={<LinkButton href="/publisher/sites/new">Add website</LinkButton>}>Register a site, verify that you own its domain, then submit it for review. Ads serve only on approved sites.</EmptyState></Card>
              ) : (
                <Card>
                  <CardHeader title="Websites by status" actions={<Link className="text-sm text-primary hover:underline" href="/publisher/sites">Manage websites</Link>} />
                  <div className="flex flex-wrap gap-3">{sites.map(([s, n]) => <span key={s} className="rounded-lg border border-border px-3 py-2 text-sm"><span className="font-semibold tabular">{n}</span> <span className="text-muted">{humanize(s)}</span></span>)}</div>
                </Card>
              )}
              {!none && (
                <>
                  <Card><CardHeader title="Daily valid impressions" /><TrendChart data={data.trend} series={[{ key: 'validImpressions', label: 'Valid impressions', color: 'var(--chart-1)' }, { key: 'validClicks', label: 'Valid clicks', color: 'var(--chart-2)' }]} /></Card>
                  <div className="grid gap-5 lg:grid-cols-2">
                    <Card><CardHeader title="Placements" description="Valid impressions" /><BreakdownBars data={data.byUnit} valueKey="validImpressions" label="Valid impressions" /></Card>
                    <Card><CardHeader title="Devices" description="Valid impressions" /><BreakdownBars data={data.byDevice} valueKey="validImpressions" label="Valid impressions" color="var(--chart-3)" /></Card>
                  </div>
                </>
              )}
            </div>
          );
        }}
      </Async>
    </>
  );
}
