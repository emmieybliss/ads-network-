import { Fragment, type ReactNode } from 'react';
import cn from 'clsx';

/**
 * Renders content bodies written in the admin Content editor: blank lines
 * between paragraphs, "# " headings, "## " sub-headings and "- " list items.
 * Email addresses and web links become links. A detail the operator has not
 * supplied yet arrives as [[Label]] and is shown as a highlighted gap.
 * Nothing is passed to innerHTML.
 */
export type Block = { type: 'h2' | 'h3' | 'p'; text: string; id?: string } | { type: 'ul'; items: string[] };

export function headingId(text: string) {
  return text.toLowerCase().replace(/^\d+\.\s*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export function parseBlocks(body: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (para.length) out.push({ type: 'p', text: para.join(' ') });
    para = [];
    if (list) out.push({ type: 'ul', items: list });
    list = null;
  };
  for (const raw of body.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h = /^(#{1,2})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const text = h[2]!;
      out.push({ type: h[1] === '#' ? 'h2' : 'h3', text, id: headingId(text) });
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (para.length) { out.push({ type: 'p', text: para.join(' ') }); para = []; }
      (list ??= []).push(li[1]!);
      continue;
    }
    if (list) { out.push({ type: 'ul', items: list }); list = null; }
    para.push(line);
  }
  flush();
  return out;
}

const INLINE = /(\[\[[^\]]{1,80}\]\])|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})|(https?:\/\/[^\s<>()]+[^\s<>().,;:])/g;

export function Inline({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) parts.push(text.slice(last, i));
    if (m[1]) {
      parts.push(
        <mark key={i} title={m[1] === '[[Website address]]' ? 'Set once the site has its public domain (PUBLIC_SITE_URL).' : 'Not supplied yet. Set it in Admin › Settings › Branding.'} className="rounded bg-warning-soft px-1 py-px font-medium text-warning ring-1 ring-inset ring-warning/30">
          {m[1].slice(2, -2)}
        </mark>,
      );
    } else if (m[2]) {
      parts.push(<a key={i} className="text-primary underline-offset-2 hover:underline" href={`mailto:${m[2]}`}>{m[2]}</a>);
    } else if (m[3]) {
      parts.push(<a key={i} className="text-primary underline-offset-2 hover:underline" href={m[3]} rel="noopener noreferrer">{m[3]}</a>);
    }
    last = i + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
}

export function RichText({ body, className, compact = false }: { body: string; className?: string; compact?: boolean }) {
  const blocks = parseBlocks(body);
  return (
    <div className={cn('text-fg-2', compact ? 'space-y-3 text-[15px] leading-relaxed' : 'space-y-4 leading-relaxed', className)}>
      {blocks.map((b, i) => {
        if (b.type === 'h2') return <h2 key={i} id={b.id} className="scroll-mt-24 pt-6 text-xl font-semibold tracking-tight text-fg first:pt-0"><Inline text={b.text} /></h2>;
        if (b.type === 'h3') return <h3 key={i} id={b.id} className="scroll-mt-24 pt-2 text-base font-semibold text-fg"><Inline text={b.text} /></h3>;
        if (b.type === 'ul') return <ul key={i} className="list-disc space-y-1.5 pl-5 marker:text-muted">{b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}</ul>;
        return <p key={i}><Inline text={b.text} /></p>;
      })}
    </div>
  );
}

/** Shown above a document that still has gaps. */
export const GAPS_NOTE = 'Highlighted details have not been supplied yet. Company details are completed in Admin › Settings › Branding, and the website address once the site has its public domain.';

/** True when a document still has details the operator has not supplied. */
export function hasGaps(text: string) {
  return /\[\[[^\]]+\]\]/.test(text);
}
