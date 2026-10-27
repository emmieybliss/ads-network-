'use client';
import { useState } from 'react';
import { BarChart3, Globe2, LayoutDashboard, Megaphone, Settings, Wallet } from 'lucide-react';
import { cn } from '@/components/ui';

/**
 * An original, illustrative rendering of the product. Every number in it is
 * sample data and is labelled as such; none of it describes the real network.
 */
const ADV = {
  title: 'Spring launch campaign',
  stats: [['Valid impressions', '48,210'], ['Valid clicks', '362'], ['CTR', '0.75%'], ['Spend', '$120.53']],
  series: [12, 18, 15, 22, 27, 24, 31, 35, 33, 40, 38, 44],
  rows: [['Sidebar · techreview.example', '18,402', '0.81%'], ['In-article · gardening.example', '16,955', '0.70%'], ['Footer · recipes.example', '12,853', '0.72%']],
  rowHead: ['Placement', 'Impressions', 'CTR'],
};
const PUB = {
  title: 'gardening.example',
  stats: [['Valid impressions', '31,940'], ['Viewable', '22,817'], ['RPM', '$1.84'], ['Est. earnings', '$58.77']],
  series: [20, 22, 21, 26, 25, 29, 28, 30, 34, 33, 36, 39],
  rows: [['In-article 300×250', '14,220', '$26.10'], ['Sidebar responsive', '11,086', '$20.41'], ['In-feed text', '6,634', '$12.26']],
  rowHead: ['Placement', 'Impressions', 'Earnings'],
};

function Spark({ data }: { data: number[] }) {
  const max = Math.max(...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 100},${40 - (v / max) * 34}`).join(' ');
  return (
    <svg viewBox="0 0 100 42" preserveAspectRatio="none" className="h-28 w-full" aria-hidden>
      <defs>
        <linearGradient id="pv-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--primary)" stopOpacity=".28" />
          <stop offset="1" stopColor="var(--primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,42 ${pts} 100,42`} fill="url(#pv-fill)" />
      <polyline points={pts} fill="none" stroke="var(--primary)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export function ProductPreview() {
  const [view, setView] = useState<'advertiser' | 'publisher'>('advertiser');
  const d = view === 'advertiser' ? ADV : PUB;
  const nav = view === 'advertiser'
    ? [[LayoutDashboard, 'Overview'], [Megaphone, 'Campaigns'], [BarChart3, 'Reports'], [Wallet, 'Billing']]
    : [[LayoutDashboard, 'Overview'], [Globe2, 'Websites'], [BarChart3, 'Reports'], [Wallet, 'Earnings']];
  return (
    <div className="relative">
      <div className="mb-3 flex items-center justify-center gap-1 rounded-full border border-border bg-surface p-1 shadow-sm sm:mx-auto sm:w-fit" role="tablist" aria-label="Preview">
        {(['advertiser', 'publisher'] as const).map((v) => (
          <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={cn('rounded-full px-4 py-1.5 text-sm font-medium transition-colors', view === v ? 'bg-primary text-primary-fg' : 'text-muted hover:text-fg')}>
            {v === 'advertiser' ? 'Advertiser view' : 'Publisher view'}
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-pop)]">
        <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-2.5">
          <span className="size-2.5 rounded-full bg-danger/60" /><span className="size-2.5 rounded-full bg-warning/60" /><span className="size-2.5 rounded-full bg-success/60" />
          <span className="ml-3 truncate text-xs text-muted">Illustrative preview · sample data, not network results</span>
        </div>
        <div className="grid min-h-[380px] grid-cols-1 sm:grid-cols-[180px_1fr]">
          <aside className="hidden border-r border-border bg-surface-2/50 p-3 sm:block">
            {nav.map(([Icon, label], i) => {
              const I = Icon as typeof LayoutDashboard;
              return (
                <div key={label as string} className={cn('mb-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px]', i === 0 ? 'bg-primary-soft font-medium text-primary' : 'text-muted')}>
                  <I className="size-4" aria-hidden /> {label as string}
                </div>
              );
            })}
            <div className="mt-3 flex items-center gap-2 px-2.5 py-2 text-[13px] text-muted"><Settings className="size-4" aria-hidden /> Settings</div>
          </aside>
          <div className="min-w-0 p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted">{view === 'advertiser' ? 'Campaign' : 'Website'}</p>
                <p className="font-semibold">{d.title}</p>
              </div>
              <span className="rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">{view === 'advertiser' ? 'Active' : 'Approved'}</span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              {d.stats.map(([k, v]) => (
                <div key={k} className="rounded-xl border border-border p-3">
                  <p className="text-[11px] text-muted">{k}</p>
                  <p className="tabular mt-1 text-lg font-semibold">{v}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 rounded-xl border border-border p-3">
              <p className="text-[11px] text-muted">Valid impressions · last 12 days</p>
              <Spark data={d.series} />
            </div>
            <div className="mt-3 overflow-hidden rounded-xl border border-border">
              <div className="grid grid-cols-[1fr_auto_auto] gap-4 bg-surface-2 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted">
                {d.rowHead.map((h, i) => <span key={h} className={i ? 'text-right' : ''}>{h}</span>)}
              </div>
              {d.rows.map((r) => (
                <div key={r[0]} className="grid grid-cols-[1fr_auto_auto] gap-4 border-t border-border px-3 py-2 text-[13px]">
                  <span className="truncate text-fg-2">{r[0]}</span><span className="tabular text-right">{r[1]}</span><span className="tabular w-16 text-right">{r[2]}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
