import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Reader, type CountryResponse } from 'maxmind';
import { isPrivateAddress } from '../services/verification';

/** Country of an IP address from a local MaxMind-format (.mmdb) database. */
export interface GeoLookup {
  /** Where the database came from, for the system page. */
  readonly description: string;
  /** ISO 3166 alpha-2 code, or null when the address is not in the database. */
  country(ip: string): string | null;
}

function lookupFrom(buf: Buffer): GeoLookup & { builtAt: string; type: string } {
  const reader = new Reader<CountryResponse>(buf);
  // mmdb-lib gives the build time as a Date (older versions: seconds since 1970).
  const epoch = reader.metadata.buildEpoch as unknown as Date | number;
  const built = new Date(epoch instanceof Date ? epoch.getTime() : Number(epoch) * 1000).toISOString().slice(0, 10);
  return {
    type: reader.metadata.databaseType,
    builtAt: built,
    description: `${reader.metadata.databaseType} (built ${built})`,
    country(ip) {
      try {
        const r = reader.get(ip);
        const code = r?.country?.iso_code ?? r?.registered_country?.iso_code;
        return code && /^[A-Z]{2}$/.test(code) ? code : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Opens a country database such as DB-IP "IP to Country Lite" (free, CC BY 4.0)
 * or MaxMind GeoLite2 Country. The file is read once into memory; lookups are
 * synchronous. Returns null, with a warning, when the path is set but unusable,
 * so a missing file never stops the server.
 */
export function openGeoDb(path: string, warn: (msg: string) => void): (GeoLookup & { builtAt: string }) | null {
  if (!path) return null;
  if (!existsSync(path)) { warn(`GEOIP_DB_PATH ${path} does not exist; countries are reported as unknown.`); return null; }
  try {
    return lookupFrom(readFileSync(path));
  } catch (err) {
    warn(`GEOIP_DB_PATH ${path} could not be read as a .mmdb database (${(err as Error).message}); countries are reported as unknown.`);
    return null;
  }
}

/** How a visitor's country was decided, for the IP lookup tool. */
export type CountrySource = 'header' | 'database' | 'local_test' | 'unknown';

export interface GeoStatus {
  header: string | null;
  database: { path: string; description: string | null; fileDate: string | null; attribution: { text: string; url: string } | null } | null;
  autoUpdate: { enabled: boolean; source: string; lastCheckAt: string | null; lastResult: string | null; lastError: string | null; nextCheckAt: string | null };
  localTestCountry: string | null;
  /** Whether the local test country can be changed (development only). */
  localTestAllowed: boolean;
}

export interface GeoIpOptions {
  path: string;
  header: string;
  autoUpdate: boolean;
  downloadUrl: string;
  /** Development only; the configuration refuses it in production. */
  localCountry: string;
  allowLocalTest: boolean;
  warn: (msg: string) => void;
  info?: (msg: string) => void;
  /** Swapped in for tests. */
  fetch?: typeof fetch;
}

const DAY = 86_400_000;

/**
 * Country lookup for ad serving: the CDN's country header when there is one,
 * else the local database, else unknown ("ZZ"). Keeps the database current
 * when GEOIP_AUTO_UPDATE is on: checks once a day, downloads the new monthly
 * file when there is one, checks it opens and answers, and swaps it in
 * without a restart. A failed download keeps the database already in use.
 */
export class GeoIpService {
  db: (GeoLookup & { builtAt?: string }) | null;
  private fileDate: string | null = null;
  private lastCheckAt: Date | null = null;
  private lastResult: string | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  localCountry: string;

  constructor(private readonly o: GeoIpOptions) {
    // With auto-update on, a missing file is normal on the first start: it is about to be downloaded.
    this.db = o.autoUpdate && o.path && !existsSync(o.path) ? null : openGeoDb(o.path, o.warn);
    this.fileDate = o.path && existsSync(o.path) ? statSync(o.path).mtime.toISOString() : null;
    this.localCountry = o.localCountry;
  }

  /** The country and how it was decided. headerValue is the raw value of the configured header, if any. */
  resolve(ip: string, headerValue?: string | string[]): { country: string; source: CountrySource } {
    if (typeof headerValue === 'string' && /^[A-Z]{2}$/i.test(headerValue) && !['XX', 'T1'].includes(headerValue.toUpperCase())) return { country: headerValue.toUpperCase(), source: 'header' };
    const fromDb = this.db?.country(ip);
    if (fromDb) return { country: fromDb, source: 'database' };
    if (this.o.allowLocalTest && this.localCountry && isLocal(ip)) return { country: this.localCountry, source: 'local_test' };
    return { country: 'ZZ', source: 'unknown' };
  }

  setLocalCountry(code: string) {
    if (!this.o.allowLocalTest) throw new Error('The local test country is for development only');
    this.localCountry = code;
  }

  status(): GeoStatus {
    const dbip = /db-?ip/i.test(this.db?.description ?? '') || (this.o.autoUpdate && /db-ip/i.test(this.o.downloadUrl));
    return {
      header: this.o.header || null,
      database: this.o.path ? {
        path: this.o.path,
        description: this.db?.description ?? null,
        fileDate: this.fileDate,
        attribution: dbip && this.db ? { text: 'IP Geolocation by DB-IP', url: 'https://db-ip.com' } : null,
      } : null,
      autoUpdate: {
        enabled: this.o.autoUpdate && Boolean(this.o.path),
        source: safeSource(this.o.downloadUrl),
        lastCheckAt: this.lastCheckAt?.toISOString() ?? null,
        lastResult: this.lastResult,
        lastError: this.lastError,
        nextCheckAt: this.timer && this.lastCheckAt ? new Date(this.lastCheckAt.getTime() + DAY).toISOString() : null,
      },
      localTestCountry: this.o.allowLocalTest ? (this.localCountry || null) : null,
      localTestAllowed: this.o.allowLocalTest,
    };
  }

  /** Begin the daily check; the first one runs now. Does nothing unless auto-update is on. */
  start() {
    if (!this.o.autoUpdate || !this.o.path || this.timer) return;
    const tick = () => { void this.update().catch(() => undefined); };
    this.timer = setInterval(tick, DAY);
    this.timer.unref();
    tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Download this month's database (or last month's, early in a month before
   * the new one is published) unless the file on disk is already from this
   * month. force skips that check.
   */
  update(opts: { force?: boolean } = {}): Promise<{ updated: boolean; message: string }> {
    if (this.running) return this.running as Promise<{ updated: boolean; message: string }>;
    const p = this.doUpdate(opts).finally(() => { this.running = null; });
    this.running = p;
    return p;
  }

  private async doUpdate({ force }: { force?: boolean }): Promise<{ updated: boolean; message: string }> {
    this.lastCheckAt = new Date();
    if (!this.o.path) return this.done(false, 'GEOIP_DB_PATH is not set');
    // Another server sharing the file may have updated it: pick that up first.
    if (existsSync(this.o.path)) {
      const mtime = statSync(this.o.path).mtime;
      if (this.fileDate !== mtime.toISOString()) this.reload();
      const built = this.db?.builtAt ? new Date(this.db.builtAt) : null;
      if (!force && built && sameMonth(built, new Date())) return this.done(false, 'The database is already this month\'s');
    }
    const f = this.o.fetch ?? fetch;
    const now = new Date();
    const months = [now, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))];
    let lastErr = '';
    for (const m of months) {
      const url = this.o.downloadUrl.replace('{YYYY}', String(m.getUTCFullYear())).replace('{MM}', String(m.getUTCMonth() + 1).padStart(2, '0'));
      try {
        const res = await f(url, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) { lastErr = `${safeSource(url)} answered ${res.status}`; continue; }
        let buf: Buffer = Buffer.from(await res.arrayBuffer());
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf, { maxOutputLength: 512 * 1024 * 1024 });
        const next = lookupFrom(buf);
        // A real country database answers for well-known public resolvers.
        if (!next.country('8.8.8.8') && !next.country('1.1.1.1') && !next.country('81.2.69.160')) throw new Error('the file does not answer country lookups');
        mkdirSync(dirname(this.o.path), { recursive: true });
        const tmp = `${this.o.path}.download`;
        writeFileSync(tmp, buf);
        renameSync(tmp, this.o.path);
        this.db = next;
        this.fileDate = statSync(this.o.path).mtime.toISOString();
        this.o.info?.(`GeoIP database updated: ${next.description}`);
        return this.done(true, `Updated to ${next.description}`);
      } catch (err) {
        lastErr = `${safeSource(url)}: ${(err as Error).message}`;
      }
    }
    this.o.warn(`GeoIP update failed (${lastErr}); keeping the current database.`);
    this.lastError = lastErr;
    this.lastResult = this.db ? 'Update failed; the current database is still in use' : 'Update failed; no database yet, so countries are unknown';
    return { updated: false, message: this.lastResult };
  }

  private done(updated: boolean, message: string) {
    this.lastResult = message;
    this.lastError = null;
    return { updated, message };
  }

  private reload() {
    const next = openGeoDb(this.o.path, this.o.warn);
    if (next) this.db = next;
    this.fileDate = existsSync(this.o.path) ? statSync(this.o.path).mtime.toISOString() : null;
  }
}

function sameMonth(a: Date, b: Date) {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

/** The host of a download URL, without query strings that might carry a licence key. */
function safeSource(url: string) {
  try { return new URL(url.replace(/\{(YYYY|MM)\}/g, '0')).host; } catch { return 'the download URL'; }
}

function isLocal(ip: string) {
  try { return isPrivateAddress(ip); } catch { return false; }
}
