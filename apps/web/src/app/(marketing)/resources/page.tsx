import type { Metadata } from 'next';
import Link from 'next/link';
import { BookOpen, Code2, FileText, Flag, ShieldCheck, Scale } from 'lucide-react';

export const metadata: Metadata = { title: 'Resources' };

const ITEMS = [
  [BookOpen, 'Documentation', '/docs', 'Integration, campaign setup and measurement.'],
  [Code2, 'API reference', '/docs/api', 'OpenAPI description of every endpoint under /api/v1.'],
  [ShieldCheck, 'Publisher requirements', '/publisher-requirements', 'What reviewers check before approving a site.'],
  [Scale, 'Advertiser policies', '/policies/advertisers', 'What may and may not be advertised.'],
  [FileText, 'Publisher policies', '/policies/publishers', 'Rules for placing ads and handling traffic.'],
  [Flag, 'Report an ad or site', '/report-abuse', 'Tell us about an ad or website that breaks the rules.'],
] as const;

export default function ResourcesPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-20 sm:px-6">
      <h1 className="text-4xl font-semibold tracking-tight">Resources</h1>
      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {ITEMS.map(([Icon, t, href, d]) => (
          <Link key={href} href={href} className="group flex gap-4 rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow-card)] hover:border-primary">
            <Icon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
            <div><p className="font-semibold group-hover:text-primary">{t}</p><p className="mt-1 text-sm text-muted">{d}</p></div>
          </Link>
        ))}
      </div>
    </div>
  );
}
