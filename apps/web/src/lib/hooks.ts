'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get } from './api';

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
}

// ------------------------------------------------------------------ live reports
// One poller for the whole page: a tiny request every few seconds while the
// tab is visible, telling every live report to reload when new events arrive.

type Freshness = { builtThrough: string | null; changedAt: string | null };
const LIVE_POLL_MS = 5_000;
const liveListeners = new Set<(f: Freshness, changed: boolean) => void>();
let liveTimer: ReturnType<typeof setInterval> | null = null;
let lastFreshness: Freshness | null = null;

async function pollFreshness() {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  try {
    const { data } = await get<{ data: Freshness }>('/reports/freshness');
    const changed = lastFreshness !== null && data.changedAt !== lastFreshness.changedAt;
    lastFreshness = data;
    for (const l of liveListeners) l(data, changed);
  } catch { /* offline or signed out: try again next tick */ }
}

function subscribeLive(l: (f: Freshness, changed: boolean) => void) {
  liveListeners.add(l);
  if (lastFreshness) l(lastFreshness, false);
  if (!liveTimer) {
    void pollFreshness();
    liveTimer = setInterval(() => void pollFreshness(), LIVE_POLL_MS);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    liveListeners.delete(l);
    if (liveListeners.size === 0 && liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    }
  };
}
function onVisible() { if (document.visibilityState === 'visible') void pollFreshness(); }

/** Calls onChange whenever new events reach the reports; returns when they were last updated. */
export function useLiveReports(onChange?: () => void) {
  const [fresh, setFresh] = useState<Freshness | null>(lastFreshness);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => subscribeLive((f, changed) => { setFresh(f); if (changed) cb.current?.(); }), []);
  return fresh;
}

/**
 * GET a path and track loading/error state. Pass null to skip. With live,
 * the data reloads quietly (keeping what is on screen) when new events reach
 * the reports.
 */
export function useApi<T = any>(path: string | null, opts: { live?: boolean } = {}): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [nonce, setNonce] = useState(0);
  const current = useRef<string | null>(null);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    current.current = path;
    setLoading(true);
    setError(null);
    get<T>(path, ctrl.signal)
      .then((d) => {
        if (current.current === path) setData(d);
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError' && current.current === path) setError(e);
      })
      .finally(() => {
        if (current.current === path) setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const live = opts.live && path !== null;
  useEffect(() => (live ? subscribeLive((_f, changed) => { if (changed) reload(); }) : undefined), [live, reload]);
  return { data, error, loading, reload, setData };
}

/** Wrap an async action with pending/error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fn(...args);
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setPending(false);
    }
  }, [fn]);
  return { run, pending, error, setError };
}

export interface ClientConfig {
  pricing: { cpmEnabled: boolean; cpcEnabled: boolean; flatEnabled: boolean; defaultCurrency: string; minCampaignBudgetMicros: string; minDepositMicros?: string; minCpmMicros: string; minCpcMicros: string };
  adRefresh?: { enabled: boolean; minSeconds: number; maxPerPageView: number };
  popAds?: { enabled: boolean; popunderEnabled: boolean; maxPerVisitorPerDay: number; minMinutesBetween: number };
  creatives: { allowedFormats: string[]; maxUploadBytes: number; allowedImageTypes: string[]; allowedSizes?: Array<[number, number]> };
  eligibility: { minMonthlyPageviews: number | null; requireOriginalContent: boolean; requirePrivacyPolicy: boolean; requireContactInformation: boolean; requireTrafficIntegrity: boolean; prohibitedCategories: string[]; allowedCountries: string[]; allowedLanguages: string[]; prohibitedContent: string[]; notes: string };
  verification: { allowedMethods: string[]; challengeTtlHours: number };
  metricDefinitions: Record<string, string>;
  brand: { productName: string; supportEmail: string; publicSiteUrl: string; apiUrl: string };
}

/** Public platform configuration (pricing minimums, creative rules, eligibility). */
export function useConfig() {
  return useApi<{ data: ClientConfig }>('/public/config');
}
