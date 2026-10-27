import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { brand } from '@/lib/brand';
import { publicGet, type ContentItem } from '@/lib/server-api';

export const revalidate = 60;

const KINDS: Record<string, { kind: string; title: string }> = {
  advertisers: { kind: 'advertiser_policy', title: 'Advertiser policies' },
  publishers: { kind: 'publisher_policy', title: 'Publisher policies' },
  creatives: { kind: 'creative_rules', title: 'Creative rules' },
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
      {items.length ? (
        <div className="mt-8 space-y-10">
          {items.map((i) => (
            <section key={i.slug}>
              <h2 className="text-xl font-semibold">{i.title}</h2>
              <div className="mt-3 whitespace-pre-line leading-relaxed text-fg-2">{i.body}</div>
            </section>
          ))}
        </div>
      ) : (
        <p className="mt-6 rounded-xl border border-dashed border-border p-5 text-muted">
          These policies have not been published yet. {brand.companyName} must provide them before the network launches publicly. Questions: <a className="text-primary" href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>.
        </p>
      )}
    </div>
  );
}
