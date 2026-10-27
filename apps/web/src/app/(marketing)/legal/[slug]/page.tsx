import type { Metadata } from 'next';
import { brand } from '@/lib/brand';
import { humanize } from '@/lib/format';
import { publicGet, type ContentItem } from '@/lib/server-api';

export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return { title: humanize(slug) };
}

/** Legal documents are managed as content by the operator. Nothing here is invented. */
export default async function LegalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const items = await publicGet<ContentItem[]>('/public/content?kind=legal');
  const doc = items?.find((i) => i.slug === slug);
  return (
    <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
      <h1 className="text-4xl font-semibold tracking-tight">{doc?.title ?? humanize(slug)}</h1>
      {doc ? (
        <>
          <p className="mt-2 text-sm text-muted">Last updated {new Date(doc.updated_at).toLocaleDateString('en-US', { dateStyle: 'long' })}</p>
          <div className="mt-8 whitespace-pre-line leading-relaxed text-fg-2">{doc.body}</div>
        </>
      ) : (
        <p className="mt-6 rounded-xl border border-dashed border-border p-5 text-muted">
          This document has not been published yet. {brand.companyName} must provide it before the network launches publicly. Questions: <a className="text-primary" href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>.
        </p>
      )}
    </div>
  );
}
