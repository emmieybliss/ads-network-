import type { Metadata } from 'next';
import { ArrowRight, BarChart3, FileCheck2, Gauge, ShieldCheck, Target, Wallet } from 'lucide-react';
import { LinkButton } from '@/components/ui';

export const metadata: Metadata = { title: 'For advertisers', description: 'Run CPM, flat-rate and CPC campaigns across independent publisher websites, with transparent reporting and prepaid budgets.' };

const POINTS = [
  [Target, 'Reach the right pages', 'Target by country, device, content category and keywords, and include or exclude specific publishers and placements.'],
  [Wallet, 'Stay in control of spend', 'Prepaid funding, a reserved budget per campaign, daily limits and pacing. A campaign can never spend more than its budget.'],
  [FileCheck2, 'Creative review and versions', 'Image banners and text ads are validated, reviewed and versioned. Only approved versions serve.'],
  [BarChart3, 'Reporting you can audit', 'Impressions, viewable impressions, clicks, CTR, spend, eCPM and eCPC by day, publisher, placement, device and country.'],
  [ShieldCheck, 'Invalid traffic is not billed', 'Duplicates, replays, crawlers and abnormal bursts are excluded before billing, and later exclusions are refunded.'],
  [Gauge, 'Frequency and pacing', 'Cap how often a visitor sees your ads and spread delivery evenly across the day.'],
] as const;

export default function AdvertisersPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
      <p className="text-sm font-semibold text-primary">For advertisers</p>
      <h1 className="mt-2 max-w-3xl text-4xl font-semibold tracking-tight">Advertising on independent websites, with numbers you can check</h1>
      <p className="mt-4 max-w-2xl text-lg text-muted">Create campaigns, upload creatives and fund your account. Every campaign and creative is reviewed before it serves, and every charge appears in your ledger.</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <LinkButton href="/register?type=advertiser" size="lg">Create an advertiser account <ArrowRight className="size-4" /></LinkButton>
        <LinkButton href="/docs#advertisers" size="lg" variant="secondary">Read the advertiser guide</LinkButton>
      </div>
      <div className="mt-16 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        {POINTS.map(([Icon, t, d]) => (
          <div key={t} className="rounded-2xl border border-border bg-surface p-6 shadow-[var(--shadow-card)]">
            <Icon className="size-5 text-primary" aria-hidden />
            <h2 className="mt-3 font-semibold">{t}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{d}</p>
          </div>
        ))}
      </div>
      <div className="mt-16 rounded-2xl border border-border bg-surface p-6">
        <h2 className="text-lg font-semibold">Campaign lifecycle</h2>
        <p className="mt-1 text-sm text-muted">Draft → Pending review → Approved → Scheduled or Active → Paused or Completed. Campaigns can also be rejected or suspended by review, with a reason you can see.</p>
      </div>
    </div>
  );
}
