/**
 * Fixture builders. They write to the database directly rather than going
 * through the API, so a test about (say) serving does not depend on the whole
 * signup and approval flow passing first.
 */
import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hashPassword } from '@blissnova/api/lib/crypto';
import { toMicros } from '@blissnova/shared';

type Db = Pool | PoolClient;

let seq = 0;
export const uniq = (p = 'x') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${randomBytes(2).toString('hex')}`;

/** Hashing a password with argon2 costs ~100ms; tests reuse one hash. */
let cachedHash: Promise<string> | null = null;
export const TEST_PASSWORD = 'Test-Password-9271!';
export function testPasswordHash(): Promise<string> {
  cachedHash ??= hashPassword(TEST_PASSWORD);
  return cachedHash;
}

export async function makeUser(
  db: Db,
  opts: { email?: string; name?: string; platformRole?: string | null; verified?: boolean; status?: string; mfa?: boolean } = {},
) {
  const email = opts.email ?? `${uniq('u')}@example.com`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, status, platform_role, email_verified_at, mfa_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      email,
      opts.name ?? 'Test Person',
      await testPasswordHash(),
      opts.status ?? 'active',
      opts.platformRole ?? null,
      opts.verified === false ? null : new Date(),
      opts.mfa ?? false,
    ],
  );
  return { id: r.rows[0]!.id, email, password: TEST_PASSWORD };
}

export async function makeOrg(
  db: Db,
  opts: { type: 'advertiser' | 'publisher'; ownerId: string; name?: string; status?: string; revenueShareBps?: number; restrictions?: object },
) {
  const r = await db.query<{ id: string }>(
    `INSERT INTO organizations (name, type, status, currency, revenue_share_bps, restrictions, created_by, billing_email)
     VALUES ($1, $2, $3, 'USD', $4, $5, $6, $7) RETURNING id`,
    [
      opts.name ?? `Org ${uniq('o')}`,
      opts.type,
      opts.status ?? 'approved',
      opts.revenueShareBps ?? null,
      JSON.stringify(opts.restrictions ?? {}),
      opts.ownerId,
      `billing-${uniq()}@example.com`,
    ],
  );
  const id = r.rows[0]!.id;
  await db.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, opts.ownerId]);
  return id;
}

export async function addMember(db: Db, orgId: string, userId: string, role: 'owner' | 'manager' | 'analyst') {
  await db.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)`, [orgId, userId, role]);
}

export async function makeSite(
  db: Db,
  opts: { orgId: string; domain?: string; status?: string; category?: string; allowed?: string[]; revenueShareBps?: number; formats?: string[]; scope?: 'host' | 'zone' },
) {
  const domain = opts.domain ?? `${uniq('s')}.example.org`;
  const publicKey = `pk_${randomBytes(15).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}`;
  const status = opts.status ?? 'approved';
  const verifiedStatus = ['verified', 'submitted', 'under_review', 'approved', 'suspended'].includes(status);
  const r = await db.query<{ id: string }>(
    `INSERT INTO sites (org_id, name, domain, allowed_domains, category, status, public_key, allowed_formats, revenue_share_bps, verified_at, approved_at, verification_method, verification_scope, policy_accepted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $11) RETURNING id`,
    [
      opts.orgId,
      `Site ${domain}`,
      domain,
      opts.allowed ?? [domain],
      opts.category ?? 'general',
      status,
      publicKey,
      opts.formats ?? ['image', 'text'],
      opts.revenueShareBps ?? null,
      verifiedStatus ? new Date() : null,
      status === 'approved' ? new Date() : null,
      verifiedStatus ? 'dns_txt' : null,
      verifiedStatus ? (opts.scope ?? 'zone') : null,
    ],
  );
  return { id: r.rows[0]!.id, publicKey, domain };
}

export async function makeUnit(
  db: Db,
  opts: { siteId: string; key?: string; formats?: string[]; width?: number | null; height?: number | null; responsive?: boolean; status?: string },
) {
  const key = opts.key ?? `slot_${uniq('')}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const r = await db.query<{ id: string }>(
    `INSERT INTO ad_units (site_id, key, name, formats, width, height, responsive, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      opts.siteId,
      key,
      `Unit ${key}`,
      opts.formats ?? ['image', 'text'],
      opts.width === undefined ? 300 : opts.width,
      opts.height === undefined ? 250 : opts.height,
      opts.responsive ?? false,
      opts.status ?? 'active',
    ],
  );
  return { id: r.rows[0]!.id, key };
}

export async function makeCampaign(
  db: Db,
  opts: {
    orgId: string;
    createdBy?: string;
    model?: 'cpm' | 'cpc' | 'flat';
    rate?: string;
    lifetime?: string;
    daily?: string | null;
    status?: string;
    priority?: number;
    pacing?: 'even' | 'asap';
    startAt?: Date;
    endAt?: Date | null;
    targeting?: { countries?: string[]; devices?: string[]; siteCategories?: string[]; keywords?: string[]; requirePersonalized?: boolean; includeSiteIds?: string[]; excludeSiteIds?: string[] };
  },
) {
  const r = await db.query<{ id: string }>(
    `INSERT INTO campaigns (org_id, name, status, pricing_model, rate_micros, currency, lifetime_budget_micros, daily_budget_micros,
                            timezone, start_at, end_at, pacing, priority, created_by, submitted_at, approved_at)
     VALUES ($1, $2, $3, $4, $5, 'USD', $6, $7, 'UTC', $8, $9, $10, $11, $12, now(), now()) RETURNING id`,
    [
      opts.orgId,
      `Campaign ${uniq('c')}`,
      opts.status ?? 'active',
      opts.model ?? 'cpm',
      toMicros(opts.rate ?? '2.00').toString(),
      toMicros(opts.lifetime ?? '1000').toString(),
      opts.daily === null ? null : toMicros(opts.daily ?? '100').toString(),
      opts.startAt ?? new Date(Date.now() - 3600_000),
      opts.endAt ?? null,
      opts.pacing ?? 'asap',
      opts.priority ?? 5,
      opts.createdBy ?? null,
    ],
  );
  const id = r.rows[0]!.id;
  const t = opts.targeting ?? {};
  await db.query(
    `INSERT INTO campaign_targeting (campaign_id, countries, devices, site_categories, keywords, include_site_ids, exclude_site_ids, require_personalized)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      t.countries ?? [],
      t.devices ?? [],
      t.siteCategories ?? [],
      t.keywords ?? [],
      t.includeSiteIds ?? [],
      t.excludeSiteIds ?? [],
      t.requirePersonalized ?? false,
    ],
  );
  return id;
}

export async function makeCreative(
  db: Db,
  opts: { campaignId: string; orgId: string; format?: 'image' | 'text'; status?: string; width?: number; height?: number; destination?: string },
) {
  const format = opts.format ?? 'text';
  const destination = opts.destination ?? 'https://example.com/landing';
  const status = opts.status ?? 'approved';
  const verifiedStatus = ['verified', 'submitted', 'under_review', 'approved', 'suspended'].includes(status);
  const approvedVersion = status === 'approved' ? 1 : null;
  let assetId: string | null = null;
  if (format === 'image') {
    const sha = randomBytes(32).toString('hex');
    assetId = (
      await db.query<{ id: string }>(
        `INSERT INTO assets (org_id, sha256, mime_type, size_bytes, width, height, storage_key)
         VALUES ($1, $2, 'image/png', 120, $3, $4, $5) RETURNING id`,
        [opts.orgId, sha, opts.width ?? 300, opts.height ?? 250, `test/${sha}.png`],
      )
    ).rows[0]!.id;
  }
  const r = await db.query<{ id: string }>(
    `INSERT INTO creatives (campaign_id, org_id, name, format, status, version, approved_version, headline, body, cta,
                            asset_id, width, height, destination_url, display_url, alt_text)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11, $12, $13, 'example.com', $14) RETURNING id`,
    [
      opts.campaignId,
      opts.orgId,
      `Creative ${uniq('cr')}`,
      format,
      status,
      approvedVersion,
      format === 'text' ? 'Test headline' : null,
      format === 'text' ? 'Test body copy for an advertisement.' : null,
      format === 'text' ? 'Learn more' : null,
      assetId,
      format === 'image' ? (opts.width ?? 300) : null,
      format === 'image' ? (opts.height ?? 250) : null,
      destination,
      format === 'image' ? 'Test banner' : null,
    ],
  );
  const id = r.rows[0]!.id;
  if (approvedVersion) {
    const snapshot =
      format === 'image'
        ? { format, assetId, storageKey: `test/${randomBytes(8).toString('hex')}.png`, width: opts.width ?? 300, height: opts.height ?? 250, destinationUrl: destination, displayUrl: 'example.com', altText: 'Test banner' }
        : { format, headline: 'Test headline', body: 'Test body copy for an advertisement.', cta: 'Learn more', destinationUrl: destination, displayUrl: 'example.com' };
    await db.query(`INSERT INTO creative_versions (creative_id, version, snapshot) VALUES ($1, 1, $2)`, [id, JSON.stringify(snapshot)]);
  }
  return id;
}

/** Credits an advertiser wallet by confirming a simulated payment. */
export async function fundOrg(db: Pool, orgId: string, amount = '1000') {
  const { confirmPayment } = await import('@blissnova/billing');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const p = (
      await client.query<{ id: string }>(
        `INSERT INTO payments (id, org_id, provider, idempotency_key, amount_micros, fee_micros, currency, status, refunded_micros, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'dev_simulated', $2, $3, 0, 'USD', 'pending', 0, now(), now()) RETURNING id`,
        [orgId, `test-${uniq()}`, toMicros(amount).toString()],
      )
    ).rows[0]!.id;
    await confirmPayment(client, { paymentId: p, actor: { type: 'system' }, feeBps: 0, invoicePrefix: 'TEST' });
    await client.query('COMMIT');
    return p;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Reserves a campaign's budget from its organisation's wallet. */
export async function reserve(db: Pool, campaignId: string) {
  const { reserveCampaignBudget } = await import('@blissnova/billing');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await reserveCampaignBudget(client, campaignId, { type: 'system' });
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function setSettings(db: Db, group: string, value: object) {
  await db.query(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = platform_settings.value || $2::jsonb, updated_at = now()`,
    [group, JSON.stringify(value)],
  );
}
