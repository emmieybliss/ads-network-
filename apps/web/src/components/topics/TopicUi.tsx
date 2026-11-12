'use client';
import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { SAFETY_LEVEL_LABELS, TOPICS, safetyCategoryLabel, topicLabel, type PageSafety } from '@blissnova/shared';
import { Badge, cn } from '@/components/ui';

const SAFETY_TONE: Record<PageSafety, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = { safe: 'success', low: 'info', medium: 'warning', high: 'danger', unknown: 'neutral' };

/** Brand-safety risk of a page as a small badge, with the flagged categories as a tooltip. */
export function SafetyBadge({ level, flags }: { level: string; flags?: Array<{ category: string; risk: string }> }) {
  const l = (level in SAFETY_TONE ? level : 'unknown') as PageSafety;
  const Icon = l === 'safe' ? ShieldCheck : l === 'unknown' ? ShieldQuestion : ShieldAlert;
  const title = flags?.length ? flags.map((f) => `${safetyCategoryLabel(f.category)}: ${f.risk}`).join('\n') : undefined;
  return (
    <span title={title}>
      <Badge tone={SAFETY_TONE[l]}><Icon className="size-3" aria-hidden />{SAFETY_LEVEL_LABELS[l]}</Badge>
    </span>
  );
}

export function TopicBadge({ id, muted }: { id: string | null | undefined; muted?: boolean }) {
  return <Badge tone={id ? (muted ? 'neutral' : 'primary') : 'neutral'}>{topicLabel(id)}</Badge>;
}

/** Toggle chips for choosing topics. */
export function TopicPicker({ value, onChange, disabled = [], label }: { value: string[]; onChange: (v: string[]) => void; disabled?: string[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {TOPICS.map((t) => {
        const on = value.includes(t.id);
        const off = disabled.includes(t.id);
        return (
          <button
            key={t.id}
            type="button"
            aria-pressed={on}
            disabled={off}
            onClick={() => onChange(on ? value.filter((x) => x !== t.id) : [...value, t.id])}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
              on ? 'border-primary bg-primary text-primary-fg' : 'border-border bg-surface text-fg-2 hover:bg-surface-2',
              off && 'cursor-not-allowed opacity-40',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
