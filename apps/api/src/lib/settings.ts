import type { Pool } from 'pg';
import { SETTINGS_GROUPS, settingsSchema, type PlatformSettings, type SettingsGroup } from '@blissnova/shared';

/**
 * Platform settings live in the platform_settings table (one row per group)
 * and are validated against the shared zod schema on every read and write.
 * Reads are cached briefly so the ad server does not hit Postgres per request.
 */
export class SettingsService {
  private cache: { value: PlatformSettings; at: number } | null = null;
  constructor(private db: Pool, private ttlMs = 5000) {}

  async get(): Promise<PlatformSettings> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.value;
    const rows = (await this.db.query<{ key: string; value: unknown }>('SELECT key, value FROM platform_settings')).rows;
    const raw: Record<string, unknown> = {};
    for (const r of rows) if ((SETTINGS_GROUPS as readonly string[]).includes(r.key)) raw[r.key] = r.value;
    const parsed = settingsSchema.safeParse(raw);
    // A stored value that no longer validates (e.g. after a schema change) falls back to defaults for that group rather than breaking delivery.
    const value = parsed.success ? parsed.data : settingsSchema.parse(Object.fromEntries(Object.entries(raw).filter(([k, v]) => settingsSchema.shape[k as SettingsGroup].safeParse(v).success)));
    this.cache = { value, at: Date.now() };
    return value;
  }

  invalidate() {
    this.cache = null;
  }

  /** Validate and persist one group. Returns before/after for auditing. */
  async update(group: SettingsGroup, patch: Record<string, unknown>, actorId: string) {
    const current = await this.get();
    const merged = { ...current[group], ...patch };
    const validated = settingsSchema.shape[group].parse(merged);
    await this.db.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [group, JSON.stringify(validated), actorId],
    );
    this.invalidate();
    return { before: current[group], after: validated };
  }
}
