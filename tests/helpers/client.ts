/**
 * A tiny cookie-aware client over Fastify's inject(), so tests exercise the
 * same CSRF and session handling a browser would.
 */
import type { FastifyInstance } from 'fastify';
import { BROWSER_UA } from './app';

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

export class Client {
  private cookies = new Map<string, string>();

  constructor(private readonly app: FastifyInstance) {}

  get csrf(): string | undefined {
    return this.cookies.get('bn_csrf');
  }

  get authenticated(): boolean {
    return this.cookies.has('bn_session');
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clearCookies(): void {
    this.cookies.clear();
  }

  async req<T = any>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    opts: { body?: unknown; headers?: Record<string, string>; payload?: unknown; noCsrf?: boolean } = {},
  ): Promise<Res<T>> {
    const headers: Record<string, string> = { 'user-agent': BROWSER_UA, ...opts.headers };
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    const csrf = this.csrf;
    if (csrf && !opts.noCsrf && method !== 'GET') headers['x-csrf-token'] = csrf;

    const r = await this.app.inject({ method, url, headers, payload: (opts.payload ?? opts.body) as any });

    for (const raw of setCookies(r.headers['set-cookie'])) {
      const [pair] = raw.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (value === '' || /expires=thu, 01 jan 1970/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }

    let body: unknown = r.body;
    const ct = String(r.headers['content-type'] ?? '');
    if (ct.includes('application/json') && r.body) {
      try {
        body = JSON.parse(r.body);
      } catch {
        /* leave as text */
      }
    }
    return { status: r.statusCode, body: body as T, headers: r.headers as Record<string, unknown> };
  }

  get<T = any>(url: string, headers?: Record<string, string>) {
    return this.req<T>('GET', url, { headers });
  }
  post<T = any>(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.req<T>('POST', url, { body, headers });
  }
  patch<T = any>(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.req<T>('PATCH', url, { body, headers });
  }
  del<T = any>(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.req<T>('DELETE', url, { body, headers });
  }
}

function setCookies(h: unknown): string[] {
  if (!h) return [];
  return Array.isArray(h) ? (h as string[]) : [String(h)];
}
