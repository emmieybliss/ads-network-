'use client';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Async, Card, CardHeader, EmptyState, LinkButton, PageHeader, Stat } from '@/components/ui';
import { BreakdownBars, TrendChart } from '@/components/charts';
import { useApi } from '@/lib/hooks';
import { useOrg } from '@/lib/session';
import { formatMicros, formatNumber, formatPercent, humanize } from '@/lib/format';

export default function AdvertiserOverview() {
  const org = useOrg();
  const res = useApi<{ data: any }>(`/orgs/${org.id}/dashboard`);
  const money = (v: string | null | undefined) => formatMicros(v, org.currency);
  return (
    <>
      <PageHeader title="Overview" description="Last 30 days across all your campaigns. Figures count validated events only." actions={<LinkButton href="/advertiser/campaigns/new"><Plus className="size-4" /> New campaign</LinkButton>} />
      <Async res={res}>
        {({ data }) => {
          const t = data.totals;
          const none = !t.validImpressions && !t.served;
          const statuses = Object.entries(data.campaigns as Record<string, number>);
          return (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="Available balance" value={money(data.walletMicros)} hint={<Link className="text-primary hover:underline" href="/advertiser/billing">Add funds</Link>} />
                <Stat label="Remaining campaign budget" value={money(data.remainingBudgetMicros)} />
                <Stat label="Spend (30 days)" value={money(t.spendMicros)} />
                <Stat label="CTR" value={formatPercent(t.ctr)} definition="Valid clicks divided by valid impressions, multiplied by 100." />
                <Stat label="Valid impressions" value={formatNumber(t.validImpressions)} />
                <Stat label="Viewable impressions" value={formatNumber(t.viewableImpressions)} />
                <Stat label="Valid clicks" value={formatNumber(t.validClicks)} />
                <Stat label="eCPM" value={money(t.ecpmMicros)} />
              </div>
              {statuses.length === 0 ? (
                <Card><EmptyState title="No campaigns yet" action={<LinkButton href="/advertiser/campaigns/new">Create your first campaign</LinkButton>}>Create a campaign, add a creative and submit it for review. Ads serve only after approval and only while your balance covers the budget.</EmptyState></Card>
              ) : (
                <Card>
                  <CardHeader title="Campaigns by status" actions={<Link className="text-sm text-primary hover:underline" href="/advertiser/campaigns">View all</Link>} />
                  <div className="flex flex-wrap gap-3">
                    {statuses.map(([s, n]) => <Link key={s} href={`/advertiser/campaigns?status=${s}`} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-2"><span className="font-semibold tabular">{n}</span> <span className="text-muted">{humanize(s)}</span></Link>)}
                  </div>
                </Card>
              )}
              {none ? (
                statuses.length > 0 && <Card><EmptyState title="No delivery in the last 30 days">Once an approved campaign serves on approved publisher sites, valid impressions and clicks appear here.</EmptyState></Card>
              ) : (
                <>
                  <Card>
                    <CardHeader title="Daily delivery" />
                    <TrendChart data={data.trend} series={[{ key: 'validImpressions', label: 'Valid impressions', color: 'var(--chart-1)' }, { key: 'validClicks', label: 'Valid clicks', color: 'var(--chart-2)' }]} />
                  </Card>
                  <div className="grid gap-5 lg:grid-cols-2">
                    <Card><CardHeader title="Top publisher sites" description="Valid impressions" /><BreakdownBars data={data.bySite} valueKey="validImpressions" label="Valid impressions" /></Card>
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
