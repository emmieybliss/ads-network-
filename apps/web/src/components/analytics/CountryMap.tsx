'use client';
import { useEffect, useMemo, useState } from 'react';
import { countryName } from './parts';

interface WorldShapes { width: number; height: number; countries: Array<[string, string]> }

let shapes: Promise<WorldShapes> | null = null;
/** The outlines (Natural Earth 1:110m, pre-projected) load once, in their own chunk. */
function loadShapes(): Promise<WorldShapes> {
  shapes ??= import('./world-110m.json').then((m) => (m.default ?? m) as unknown as WorldShapes);
  return shapes;
}

const STEPS = [18, 36, 56, 78, 100];

/**
 * World map shaded by one metric per country, in five steps of the same
 * sequential scale as the hour-of-day heatmap. Square-root steps, so one large
 * country does not wash out the rest. Countries with nothing recorded stay grey.
 */
export function CountryMap({ values, format, label, selected, onSelect }: {
  values: Map<string, number>;
  format: (v: number) => string;
  label: string;
  selected?: string | null;
  onSelect?: (code: string | null) => void;
}) {
  const [world, setWorld] = useState<WorldShapes | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => { let live = true; loadShapes().then((w) => live && setWorld(w)).catch(() => undefined); return () => { live = false; }; }, []);

  const max = useMemo(() => Math.max(0, ...values.values()), [values]);
  const step = (v: number) => (v > 0 && max > 0 ? Math.min(STEPS.length - 1, Math.floor(Math.sqrt(v / max) * STEPS.length)) : -1);
  const fill = (v: number | undefined) => {
    const s = step(v ?? 0);
    return s < 0 ? 'var(--surface-2)' : `color-mix(in oklab, var(--chart-1) ${STEPS[s]}%, var(--surface))`;
  };
  const focus = hover ?? selected ?? null;

  if (!world) return <div className="aspect-[96/46] w-full animate-pulse rounded-lg bg-surface-2" aria-hidden />;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${world.width} ${world.height}`} className="h-auto w-full" role="img" aria-label={`World map of ${label.toLowerCase()} by country`}>
        {world.countries.map(([code, d]) => (
          <path key={code} d={d} fill={fill(values.get(code))}
            stroke={code === focus ? 'var(--fg)' : 'var(--surface)'} strokeWidth={code === focus ? 1.2 : 0.5}
            className={onSelect ? 'cursor-pointer' : undefined}
            onMouseEnter={() => setHover(code)} onMouseLeave={() => setHover(null)}
            onClick={() => onSelect?.(selected === code ? null : code)}>
            <title>{`${countryName(code)}: ${values.has(code) ? format(values.get(code)!) : 'nothing recorded'}`}</title>
          </path>
        ))}
      </svg>
      {focus && (
        <div className="pointer-events-none absolute left-2 top-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-sm">
          <div className="font-medium text-fg">{countryName(focus)}</div>
          <div className="tabular text-muted">{label}: <span className="text-fg">{values.has(focus) ? format(values.get(focus)!) : 'nothing recorded'}</span></div>
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
        <span className="mr-1 inline-flex items-center gap-1"><span className="size-3 rounded-[3px] bg-surface-2" /> None</span>
        <span>Less</span>
        {STEPS.map((p) => <span key={p} className="size-3 rounded-[3px]" style={{ background: `color-mix(in oklab, var(--chart-1) ${p}%, var(--surface))` }} />)}
        <span>More{max > 0 ? ` (up to ${format(max)})` : ''}</span>
      </div>
    </div>
  );
}
