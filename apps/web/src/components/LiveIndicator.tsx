'use client';
import { useEffect, useState } from 'react';
import { useLiveReports } from '@/lib/hooks';
import { cn } from '@/components/ui';

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/**
 * "Live" chip for report headers: how fresh the numbers are, ticking each
 * second. Goes amber when the reports have not moved on for two minutes (the
 * background rollup is behind or stopped).
 */
export function LiveIndicator({ className }: { className?: string }) {
  const fresh = useLiveReports();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const through = fresh?.builtThrough ? Date.parse(fresh.builtThrough) : null;
  const behind = through !== null && now - through > 120_000;
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium', behind ? 'border-warning/40 bg-warning/10 text-warning' : 'border-success/30 bg-success/10 text-success', className)}
      title="Reports include ad events up to a few seconds ago and update on their own. Earnings stay estimated until the month is finalized."
      data-testid="live-indicator"
    >
      <span className="relative flex size-2">
        {!behind && <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-50" />}
        <span className="relative inline-flex size-2 rounded-full bg-current" />
      </span>
      {through === null ? 'Live' : behind ? `Delayed, updated ${ago(now - through)}` : `Live · updated ${ago(now - through)}`}
    </span>
  );
}
