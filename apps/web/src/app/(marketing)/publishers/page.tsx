import type { Metadata } from 'next';
import { ArrowRight, BadgeCheck, Code2, Coins, Eye, LayoutGrid, Scale } from 'lucide-react';
import { LinkButton } from '@/components/ui';

export const metadata: Metadata = { title: 'For publishers', description: 'Monetize your website with a lightweight JavaScript ad tag, automatic domain verification and transparent earnings.' };

const POINTS = [
  [BadgeCheck, 'Verify in minutes', 'Prove you control your domain with a DNS TXT record, a verification file or a meta tag. No plugin and no manual wait.'],
  [Code2, 'One small tag', 'A framework-free script that lazy-loads ads, isolates them from your styles and collapses cleanly when there is no ad.'],
  [LayoutGrid, 'Your placements', 'Create fixed or responsive placements for headers, sidebars, articles and feeds, and pause them at any time.'],
  [Eye, 'Viewability and quality', 'We measure viewability to the industry standard and keep invalid traffic away from your reports and your reputation.'],
  [Coins, 'Earnings you can follow', 'Estimated earnings become finalized after a review hold. Request payouts once you pass the minimum set by the network.'],
  [Scale, 'Fair review', 'If traffic is excluded you can see why and appeal. Decisions and adjustments are recorded.'],
] as const;

export default function PublishersPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
      <p className="text-sm font-semibold text-primary">For publishers</p>
      <h1 className="mt-2 max-w-3xl text-4xl font-semibold tracking-tight">Turn quality content into advertising revenue</h1>
      <p className="mt-4 max-w-2xl text-lg text-muted">Add your website, verify it, and once it is approved place ads where they suit your readers. We do not promise a fill rate or a level of revenue; we show you exactly what was delivered and earned.</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <LinkButton href="/register?type=publisher" size="lg">Monetize your website <ArrowRight className="size-4" /></LinkButton>
        <LinkButton href="/publisher-requirements" size="lg" variant="secondary">Check the requirements</LinkButton>
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
    </div>
  );
}
