import type { Metadata } from 'next';
import Link from 'next/link';
import cn from 'clsx';
import { brand } from '@/lib/brand';
import { humanize } from '@/lib/format';
import { publicGet, type ContentItem } from '@/lib/server-api';
import { GAPS_NOTE, RichText, hasGaps, parseBlocks } from '@/components/marketing/RichText';

export const revalidate = 60;

async function legalDocs() {
  return (await publicGet<ContentItem[]>('/public/content?kind=legal')) ?? [];
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const doc = (await legalDocs()).find((i) => i.slug === slug);
  return { title: doc?.title ?? humanize(slug) };
}

/** Legal documents are managed as content by the operator (Admin › Content). */
export default async function LegalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const docs = await legalDocs();
  const doc = docs.find((i) => i.slug === slug);
  const toc = doc ? parseBlocks(doc.body).filter((b) => b.type === 'h2') : [];
  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:py-20">
      <aside className="min-w-0 lg:sticky lg:top-24 lg:self-start">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">Legal</p>
        <nav aria-label="Legal documents" className="mt-3 flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
          {docs.map((d) => (
            <Link key={d.slug} href={`/legal/${d.slug}`} aria-current={d.slug === slug ? 'page' : undefined}
              className={cn('whitespace-nowrap rounded-lg px-3 py-2 text-sm', d.slug === slug ? 'bg-primary-soft font-medium text-primary' : 'text-fg-2 hover:bg-surface-2')}>
              {d.title}
            </Link>
          ))}
          <Link href={brand.legal.publisherPolicyUrl} className="whitespace-nowrap rounded-lg px-3 py-2 text-sm text-fg-2 hover:bg-surface-2">Publisher policies</Link>
          <Link href={brand.legal.advertiserPolicyUrl} className="whitespace-nowrap rounded-lg px-3 py-2 text-sm text-fg-2 hover:bg-surface-2">Advertiser policies</Link>
        </nav>
      </aside>
      <article className="min-w-0 max-w-3xl">
        <h1 className="text-4xl font-semibold tracking-tight">{doc?.title ?? humanize(slug)}</h1>
        {doc ? (
          <>
            <p className="mt-2 text-sm text-muted">Last updated {new Date(doc.updated_at).toLocaleDateString('en-US', { dateStyle: 'long' })}</p>
            {hasGaps(doc.body) && (
              <p className="mt-6 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">
                {GAPS_NOTE}
              </p>
            )}
            {toc.length > 3 && (
              <nav aria-label="On this page" className="mt-8 rounded-xl border border-border bg-surface p-5">
                <p className="text-sm font-semibold text-fg">On this page</p>
                <ol className="mt-3 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                  {toc.map((h) => h.type === 'h2' && <li key={h.id}><a className="text-muted hover:text-primary" href={`#${h.id}`}>{h.text}</a></li>)}
                </ol>
              </nav>
            )}
            <RichText body={doc.body} className="mt-8" />
          </>
        ) : (
          <p className="mt-6 rounded-xl border border-dashed border-border p-5 text-muted">
            This document has not been published yet. {brand.companyName} must provide it before the network launches publicly. Questions: <a className="text-primary" href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>.
          </p>
        )}
      </article>
    </div>
  );
}
