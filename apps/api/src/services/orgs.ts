import type { FastifyRequest } from 'fastify';
import type { OrgType } from '@blissnova/shared';
import type { AppContext } from '../lib/context';
import { audit } from '../lib/audit';
import { notifyStaff } from './notifications';

export async function createOrganization(ctx: AppContext, req: FastifyRequest, userId: string, o: { name: string; type: OrgType; website?: string | null; country?: string | null; currency?: string }) {
  const s = await ctx.settings.get();
  const currency = o.currency && s.pricing.enabledCurrencies.includes(o.currency) ? o.currency : s.pricing.defaultCurrency;
  const client = await ctx.db.connect();
  try {
    await client.query('BEGIN');
    const org = (await client.query(
      `INSERT INTO organizations (name, type, website, country, currency, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [o.name, o.type, o.website ?? null, o.country ?? null, currency, userId])).rows[0];
    await client.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [org.id, userId]);
    await audit(client, req, { action: 'organization.create', resourceType: 'organization', resourceId: org.id, orgId: org.id, after: org, actorUserId: userId });
    await client.query('COMMIT');
    await notifyStaff(ctx, ['super_admin', 'admin', 'ad_ops'], `New ${o.type} account awaiting review`, `${o.name} registered as a ${o.type}.`, `/admin/${o.type}s/${org.id}`).catch(() => undefined);
    return org;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function serializeOrg(o: Record<string, unknown>) {
  return {
    id: o.id, name: o.name, type: o.type, status: o.status, statusReason: o.status_reason, website: o.website, country: o.country,
    billingEmail: o.billing_email, currency: o.currency, createdAt: o.created_at, sellersJsonConfidential: o.sellers_json_confidential,
  };
}
