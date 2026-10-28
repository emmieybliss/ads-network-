'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, Check, Globe2, Megaphone, ShieldCheck } from 'lucide-react';
import { cn } from '@/components/ui';
import { CampaignMock, PublisherDashboardMock, ReviewQueueMock } from './mockups';

const TABS = [
  {
    id: 'advertisers',
    icon: Megaphone,
    label: 'Advertisers',
    title: 'Plan, launch and control every campaign',
    body: 'Fund your account, set a budget and a schedule, choose exactly where ads may appear, and see what each placement delivered.',
    points: ['CPM, flat-rate and (where enabled) CPC pricing', 'Country, device, category, keyword and placement targeting', 'Even or accelerated pacing with daily limits', 'Prepaid budgets with an itemised ledger'],
    href: '/advertisers',
    cta: 'Explore advertiser tools',
    mock: CampaignMock,
  },
  {
    id: 'publishers',
    icon: Globe2,
    label: 'Publishers',
    title: 'Earn from your content, on your terms',
    body: 'Verify your site, add one script tag, and choose where ads go. Demand, delivery, quality checks and payouts are handled for you.',
    points: ['One tag for every placement, no plugin required', 'Anchor, side rail, interstitial, in-article and native units', 'Page RPM and per-page earnings reports', 'Block categories and advertisers you do not want'],
    href: '/publishers',
    cta: 'Explore publisher tools',
    mock: PublisherDashboardMock,
  },
  {
    id: 'operators',
    icon: ShieldCheck,
    label: 'Network quality',
    title: 'Every ad and every site is reviewed',
    body: 'Creatives, campaigns and publisher sites go through review before anything serves, and traffic quality is checked on every event.',
    points: ['Versioned creatives with approve and reject reasons', 'Automatic domain verification before site review', 'Invalid-traffic cases with appeals and an audit trail', 'Policies for advertisers and publishers, published openly'],
    href: '/publisher-requirements',
    cta: 'Read the requirements',
    mock: ReviewQueueMock,
  },
] as const;

export function AudienceTabs() {
  const [active, setActive] = useState<(typeof TABS)[number]['id']>('advertisers');
  const tab = TABS.find((t) => t.id === active) ?? TABS[0];
  const Mock = tab.mock;
  return (
    <div>
      <div role="tablist" aria-label="Who it is for" className="inline-flex flex-wrap gap-1 rounded-xl border border-border bg-surface p-1 shadow-[var(--shadow-card)]">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === active} onClick={() => setActive(t.id)}
            className={cn('flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors', t.id === active ? 'bg-fg text-bg' : 'text-fg-2 hover:bg-surface-2')}>
            <t.icon className="size-4" aria-hidden /> {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="mt-10 grid items-center gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div>
          <h3 className="text-2xl font-semibold tracking-tight sm:text-3xl">{tab.title}</h3>
          <p className="mt-3 text-[17px] leading-relaxed text-muted">{tab.body}</p>
          <ul className="mt-6 space-y-3">
            {tab.points.map((p) => (
              <li key={p} className="flex gap-3 text-[15px] text-fg-2">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary"><Check className="size-3" aria-hidden /></span>{p}
              </li>
            ))}
          </ul>
          <Link href={tab.href} className="mt-7 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:gap-2.5 transition-all">{tab.cta} <ArrowRight className="size-4" aria-hidden /></Link>
        </div>
        <div className="relative">
          <div className="absolute -inset-6 -z-10 rounded-[28px] bg-[radial-gradient(60%_60%_at_70%_30%,color-mix(in_srgb,var(--primary)_16%,transparent),transparent)]" aria-hidden />
          <Mock />
        </div>
      </div>
    </div>
  );
}
