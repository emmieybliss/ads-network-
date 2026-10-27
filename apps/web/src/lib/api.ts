/**
 * Browser-side API client. Requests go to the web app's own origin (/api/v1 is
 * proxied to the API server), so the session cookie is first-party. Every
 * state-changing request carries the CSRF token from the readable bn_csrf
 * cookie, matching the API's double-submit check.
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public requestId?: string) {
    super(message);
  }
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const m = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : undefined;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw body (FormData for uploads). */
  form?: FormData;
  signal?: AbortSignal;
}

type StepUpHandler = () => Promise<boolean>;
let stepUpHandler: StepUpHandler | null = null;
/** Registers the UI that asks for a password when the API requires recent re-authentication. */
export function setStepUpHandler(h: StepUpHandler | null) {
  stepUpHandler = h;
}

export async function api<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, opts: RequestOptions = {}): Promise<T> {
  try {
    return await request<T>(method, path, opts);
  } catch (e) {
    // Sensitive actions need a recent password confirmation: ask once, then retry.
    if (e instanceof ApiError && e.code === 'step_up_required' && stepUpHandler && (await stepUpHandler())) return request<T>(method, path, opts);
    throw e;
  }
}

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, opts: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (method !== 'GET') {
    const csrf = readCookie('bn_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, body, credentials: 'same-origin', signal: opts.signal, cache: 'no-store' });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Could not reach the server. Check that the API is running and try again.');
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details, e?.requestId);
  }
  return data as T;
}

export const get = <T = any>(path: string, signal?: AbortSignal) => api<T>('GET', path, { signal });
export const post = <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => api<T>('POST', path, { body: body ?? {}, headers });
export const patch = <T = any>(path: string, body?: unknown) => api<T>('PATCH', path, { body: body ?? {} });
export const put = <T = any>(path: string, body?: unknown) => api<T>('PUT', path, { body: body ?? {} });
export const del = <T = any>(path: string) => api<T>('DELETE', path);

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function idempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Human-readable message for a failed request, including field-level validation details. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const d = err.details as Array<{ path?: string; message: string }> | { problems?: string[] } | undefined;
    if (Array.isArray(d) && d.length) return d.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join(' · ');
    if (d && !Array.isArray(d) && d.problems?.length) return `${err.message}: ${d.problems.join('; ')}`;
    return err.message;
  }
  return (err as Error)?.message ?? 'Something went wrong';
}
