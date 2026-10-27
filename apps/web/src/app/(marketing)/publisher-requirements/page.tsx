import type { Metadata } from 'next';
import { Check, X } from 'lucide-react';
import { LinkButton } from '@/components/ui';
import { humanize } from '@/lib/format';
import { publicGet, type PublicConfig } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Publisher requirements', description: 'What a website needs to join the BlissNova Ad Network.' };
export const revalidate = 60;

export default async function RequirementsPage() {
  const cfg = await publicGet<PublicConfig>('/public/config');
  const e = cfg?.eligibility;
  const required = [
    ['You control the domain', 'Verified automatically with DNS, a file or a meta tag.', true],
    ['Original, useful content', 'Content you created or are licensed to publish.', e?.requireOriginalContent ?? true],
    ['A published privacy policy', 'Including a consent mechanism where the law requires one.', e?.requirePrivacyPolicy ?? true],
    ['Contact information', 'Readers and the network must be able to reach you.', e?.requireContactInformation ?? true],
    ['Honest traffic', 'No bought, incentivised or automated traffic, and no encouraging clicks on ads.', e?.requireTrafficIntegrity ?? true],
  ] as const;
  return (
    <div className="mx-auto max-w-4xl px-4 py-20 sm:px-6">
      <p className="text-sm font-semibold text-primary">Publisher requirements</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">Who can join the network</h1>
      <p className="mt-4 text-lg text-muted">Every site is reviewed by a person after its domain is verified. These are the rules reviewers apply. They are configured by the network operator and this page always shows the current version.</p>
      {!cfg && <p className="mt-6 rounded-xl border border-dashed border-border p-4 text-sm text-muted">The current settings could not be loaded, so the defaults are shown.</p>}

      <h2 className="mt-12 text-xl font-semibold">Requirements</h2>
      <ul className="mt-4 divide-y divide-border rounded-2xl border border-border bg-surface">
        {required.filter(([, , on]) => on).map(([t, d]) => (
          <li key={t} className="flex gap-3 p-4"><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /><div><p className="font-medium">{t}</p><p className="text-sm text-muted">{d}</p></div></li>
        ))}
        <li className="flex gap-3 p-4">
          <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <div>
            <p className="font-medium">Traffic</p>
            <p className="text-sm text-muted">{e?.minMonthlyPageviews ? `At least ${e.minMonthlyPageviews.toLocaleString()} page views per month.` : 'No minimum traffic threshold is set at the moment.'}</p>
          </div>
        </li>
        {e && e.allowedCountries.length > 0 && <li className="flex gap-3 p-4"><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /><div><p className="font-medium">Countries</p><p className="text-sm text-muted">Sites based in: {e.allowedCountries.join(', ')}.</p></div></li>}
        {e && e.allowedLanguages.length > 0 && <li className="flex gap-3 p-4"><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /><div><p className="font-medium">Languages</p><p className="text-sm text-muted">Content in: {e.allowedLanguages.join(', ')}.</p></div></li>}
      </ul>

      <h2 className="mt-12 text-xl font-semibold">Not accepted</h2>
      <ul className="mt-4 divide-y divide-border rounded-2xl border border-border bg-surface">
        {(e?.prohibitedContent ?? ['Illegal content or services', 'Adult or sexually explicit material', 'Hate, harassment or violence', 'Copyright-infringing material', 'Malware, deceptive downloads or phishing']).map((p) => (
          <li key={p} className="flex gap-3 p-4 text-sm"><X className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />{p}</li>
        ))}
        {e?.prohibitedCategories.map((c) => <li key={c} className="flex gap-3 p-4 text-sm"><X className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />Sites in the “{humanize(c)}” category</li>)}
      </ul>
      {e?.notes && <p className="mt-6 whitespace-pre-line text-sm text-muted">{e.notes}</p>}
      <p className="mt-8 text-sm text-muted">Verification proves you control a hostname; it is not approval. A verified site can still be declined if it does not meet these requirements, and you will be told why.</p>
      <LinkButton href="/register?type=publisher" className="mt-8">Apply as a publisher</LinkButton>
    </div>
  );
}
