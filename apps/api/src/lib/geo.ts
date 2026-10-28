import { existsSync, readFileSync } from 'node:fs';
import { Reader, type CountryResponse } from 'maxmind';

/** Country of an IP address from a local MaxMind-format (.mmdb) database. */
export interface GeoLookup {
  /** Where the database came from, for the system page. */
  readonly description: string;
  /** ISO 3166 alpha-2 code, or null when the address is not in the database. */
  country(ip: string): string | null;
}

/**
 * Opens a country database such as DB-IP "IP to Country Lite" (free, CC BY 4.0)
 * or MaxMind GeoLite2 Country. The file is read once into memory; lookups are
 * synchronous. Returns null, with a warning, when the path is set but unusable,
 * so a missing file never stops the server.
 */
export function openGeoDb(path: string, warn: (msg: string) => void): GeoLookup | null {
  if (!path) return null;
  if (!existsSync(path)) { warn(`GEOIP_DB_PATH ${path} does not exist; countries are reported as unknown.`); return null; }
  try {
    const reader = new Reader<CountryResponse>(readFileSync(path));
    const built = new Date(Number(reader.metadata.buildEpoch) * 1000).toISOString().slice(0, 10);
    return {
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
  } catch (err) {
    warn(`GEOIP_DB_PATH ${path} could not be read as a .mmdb database (${(err as Error).message}); countries are reported as unknown.`);
    return null;
  }
}
