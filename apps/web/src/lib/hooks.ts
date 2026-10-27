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

/** GET a path and track loading/error state. Pass null to skip. */
export function useApi<T = any>(path: string | null): Resource<T> {
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
  pricing: { cpmEnabled: boolean; cpcEnabled: boolean; flatEnabled: boolean; defaultCurrency: string; minCampaignBudgetMicros: string; minCpmMicros: string; minCpcMicros: string };
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
