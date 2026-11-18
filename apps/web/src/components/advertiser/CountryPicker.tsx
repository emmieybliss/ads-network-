'use client';
import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/components/ui';
import { COUNTRIES, COUNTRY_GROUPS, countryLabel } from '@/lib/countries';

type Shares = Map<string, number>;

function pct(v: number | undefined) {
  if (!v) return null;
  return v < 0.001 ? '<0.1%' : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
}

function Chip({ code, onRemove, tone }: { code: string; onRemove: () => void; tone: 'include' | 'exclude' }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border py-0.5 pl-2.5 pr-1 text-xs font-medium', tone === 'include' ? 'border-primary/30 bg-primary/10 text-primary' : 'border-danger/30 bg-danger/10 text-danger')}>
      {countryLabel(code)}
      <button type="button" onClick={onRemove} className="rounded-full p-0.5 hover:bg-black/10" aria-label={`Remove ${countryLabel(code)}`}><X className="size-3" /></button>
    </span>
  );
}

function SearchList({ id, picked, onToggle, shares, placeholder }: { id: string; picked: string[]; onToggle: (code: string) => void; shares: Shares; placeholder: string }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    const hits = t ? COUNTRIES.filter((c) => c.name.toLowerCase().includes(t) || c.code.toLowerCase() === t) : COUNTRIES;
    // Without a search, countries with network traffic come first, largest first, like a reach estimate.
    return t ? hits : [...hits].sort((a, b) => (shares.get(b.code) ?? 0) - (shares.get(a.code) ?? 0));
  }, [q, shares]);
  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 text-muted" aria-hidden />
        <input id={id} value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="h-9 w-full bg-transparent text-sm outline-none" autoComplete="off" />
      </div>
      <ul className="max-h-52 overflow-y-auto py-1 text-sm" role="listbox" aria-multiselectable>
        {list.length === 0 && <li className="px-3 py-2 text-muted">No country matches “{q}”.</li>}
        {list.map((c) => {
          const on = picked.includes(c.code);
          return (
            <li key={c.code}>
              <label className={cn('flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-surface-2', on && 'bg-primary/5')}>
                <input type="checkbox" checked={on} onChange={() => onToggle(c.code)} className="size-4 accent-[var(--primary)]" />
                <span className="flex-1 truncate">{c.name}</span>
                <span className="text-xs text-muted tabular">{pct(shares.get(c.code)) ?? ''}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Location targeting like the big ad platforms: all countries or chosen ones,
 * searchable by name, with region shortcuts, plus countries to exclude. Shows
 * each country's share of the network's traffic (last 30 days) as a guide.
 */
export function CountryPicker({ include, exclude, onChange, shares: shareRows }: {
  include: string[];
  exclude: string[];
  onChange: (next: { include: string[]; exclude: string[] }) => void;
  shares?: Array<{ country: string; share: number }>;
}) {
  const shares = useMemo<Shares>(() => new Map((shareRows ?? []).map((r) => [r.country, r.share])), [shareRows]);
  const [mode, setMode] = useState<'all' | 'some'>(include.length ? 'some' : 'all');
  const [showExclude, setShowExclude] = useState(exclude.length > 0);
  const reach = include.length ? include.reduce((a, c) => a + (shares.get(c) ?? 0), 0) : 1 - exclude.reduce((a, c) => a + (shares.get(c) ?? 0), 0);
  const toggle = (list: string[], code: string) => (list.includes(code) ? list.filter((c) => c !== code) : [...list, code]);

  return (
    <div className="space-y-3" data-testid="country-picker">
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="radio" name="geo-mode" checked={mode === 'all'} onChange={() => { setMode('all'); onChange({ include: [], exclude }); }} className="accent-[var(--primary)]" /> All countries</label>
        <label className="flex items-center gap-2"><input type="radio" name="geo-mode" checked={mode === 'some'} onChange={() => setMode('some')} className="accent-[var(--primary)]" /> Choose countries</label>
      </div>

      {mode === 'some' && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {COUNTRY_GROUPS.map((g) => {
              const all = g.codes.every((c) => include.includes(c));
              return (
                <button key={g.id} type="button" onClick={() => onChange({ include: all ? include.filter((c) => !g.codes.includes(c)) : [...new Set([...include, ...g.codes])], exclude: exclude.filter((c) => all || !g.codes.includes(c)) })}
                  className={cn('rounded-full border px-2.5 py-1 text-xs font-medium', all ? 'border-primary bg-primary text-white' : 'border-border bg-surface hover:bg-surface-2')}>
                  {all ? '✓ ' : '+ '}{g.label}
                </button>
              );
            })}
          </div>
          <SearchList id="geo-include" picked={include} onToggle={(c) => onChange({ include: toggle(include, c), exclude: exclude.filter((x) => x !== c) })} shares={shares} placeholder="Search for a country" />
          {include.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted">Targeting {include.length} {include.length === 1 ? 'country' : 'countries'}:</span>
              {include.map((c) => <Chip key={c} code={c} tone="include" onRemove={() => onChange({ include: include.filter((x) => x !== c), exclude })} />)}
              <button type="button" className="text-xs text-muted underline" onClick={() => onChange({ include: [], exclude })}>Clear</button>
            </div>
          )}
          {include.length === 0 && <p className="text-xs text-warning">Pick at least one country, or choose All countries.</p>}
        </>
      )}

      <div>
        {!showExclude ? (
          <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={() => setShowExclude(true)}>+ Exclude countries</button>
        ) : (
          <div className="space-y-2">
            <div className="text-sm font-medium text-fg">Exclude</div>
            <SearchList id="geo-exclude" picked={exclude} onToggle={(c) => onChange({ include: include.filter((x) => x !== c), exclude: toggle(exclude, c) })} shares={shares} placeholder="Search for a country to exclude" />
            {exclude.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted">Never show in:</span>
                {exclude.map((c) => <Chip key={c} code={c} tone="exclude" onRemove={() => onChange({ include, exclude: exclude.filter((x) => x !== c) })} />)}
              </div>
            )}
          </div>
        )}
      </div>

      {shares.size > 0 && (
        <p className="text-xs text-muted">
          About <span className="font-medium text-fg">{pct(Math.max(0, reach)) ?? '0%'}</span> of the network's ad impressions in the last 30 days came from {mode === 'all' && !exclude.length ? 'all countries' : 'these countries'}. Visits whose country is unknown only see campaigns set to All countries.
        </p>
      )}
    </div>
  );
}
