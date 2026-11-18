import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { brand } from '@/lib/brand';
import Link from 'next/link';
import { publicGet, type ContentItem } from '@/lib/server-api';
import { GAPS_NOTE, RichText, hasGaps, headingId } from '@/components/marketing/RichText';

export const revalidate = 60;

const KINDS: Record<string, { kind: string; title: string; intro: string }> = {
  publishers: { kind: 'publisher_policy', title: 'Publisher policies', intro: 'Every site that shows our ads must follow these policies, together with the Publisher Terms. They protect visitors, advertisers and publishers alike.' },
  advertisers: { kind: 'advertiser_policy', title: 'Advertiser policies', intro: 'Every campaign, creative and landing page must follow these policies, together with the Advertiser Terms. Ads are reviewed before they serve and can be reviewed again at any time.' },
  creatives: { kind: 'creative_rules', title: 'Creative rules', intro: 'Technical and editorial requirements for every creative, in addition to the Advertiser policies.' },
};

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: KINDS[slug]?.title ?? 'Policies' };
}

/** Policies are managed as content by the operator in the admin control center. */
export default async function PolicyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const def = KINDS[slug];
  if (!def) notFound();
  const items = (await publicGet<ContentItem[]>(`/public/content?kind=${def.kind}`)) ?? [];
  return (
    <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
      <h1 className="text-4xl font-semibold tracking-tight">{def.title}</h1>
      <nav aria-label="Policies" className="mt-6 flex flex-wrap gap-2">
        {Object.entries(KINDS).map(([s, d]) => (
          <Link key={s} href={`/policies/${s}`} aria-current={s === slug ? 'page' : undefined}
            className={s === slug ? 'rounded-full bg-primary-soft px-3 py-1.5 text-sm font-medium text-primary' : 'rounded-full border border-border px-3 py-1.5 text-sm text-fg-2 hover:bg-surface-2'}>{d.title}</Link>
        ))}
      </nav>
      {items.length ? (
        <>
          <p className="mt-6 leading-relaxed text-muted">{def.intro}</p>
          {items.some((i) => hasGaps(i.body)) && (
            <p className="mt-6 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">{GAPS_NOTE}</p>
          )}
          <nav aria-label="On this page" className="mt-8 rounded-xl border border-border bg-surface p-5">
            <p className="text-sm font-semibold text-fg">On this page</p>
            <ol className="mt-3 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
              {items.map((i) => <li key={i.slug}><a className="text-muted hover:text-primary" href={`#${headingId(i.title)}`}>{i.title}</a></li>)}
            </ol>
          </nav>
          <div className="mt-10 space-y-12">
            {items.map((i) => (
              <section key={i.slug} id={headingId(i.title)} className="scroll-mt-24">
                <h2 className="text-2xl font-semibold tracking-tight">{i.title}</h2>
                <RichText body={i.body} className="mt-4" />
              </section>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-6 rounded-xl border border-dashed border-border p-5 text-muted">
          These policies have not been published yet. {brand.companyName} must provide them before the network launches publicly. Questions: <a className="text-primary" href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>.
        </p>
      )}
    </div>
  );
}
