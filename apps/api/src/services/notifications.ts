import type { AppContext } from '../lib/context';
import { EMAIL_TEMPLATES, renderTemplate } from '../lib/mailer';

type Q = { query: AppContext['db']['query'] };

/** Queue an email in the outbox and hand it to the worker (or deliver inline when queues are disabled). */
export async function queueEmail(ctx: AppContext, to: string, template: keyof typeof EMAIL_TEMPLATES | string, vars: Record<string, string | number | undefined>, db: Q = ctx.db) {
  const settings = await ctx.settings.get();
  const tpl = settings.email.templates[template] ?? EMAIL_TEMPLATES[template];
  if (!tpl) throw new Error(`Unknown email template ${template}`);
  const { subject, text } = renderTemplate(tpl, { productName: settings.branding.productName, companyName: settings.branding.companyName, supportEmail: settings.branding.supportEmail, ...vars });
  const r = await db.query<{ id: string }>('INSERT INTO email_outbox (to_address, template, subject, body_text) VALUES ($1, $2, $3, $4) RETURNING id', [to, template, subject, text]);
  const id = r.rows[0]!.id;
  if (ctx.queues.email) await ctx.queues.email.add('deliver', { id }, { jobId: `email-${id}` });
  else setImmediate(() => void deliverOutbox(ctx, id).catch((err) => ctx.log.error({ err }, 'inline email delivery failed')));
  return id;
}

export async function deliverOutbox(ctx: Pick<AppContext, 'db' | 'mailer' | 'settings'>, id: string) {
  const row = (await ctx.db.query('SELECT * FROM email_outbox WHERE id = $1', [id])).rows[0];
  if (!row || row.status === 'sent') return;
  const s = await ctx.settings.get();
  const res = await ctx.mailer.deliver({ to: row.to_address, subject: row.subject, text: row.body_text, fromName: s.email.fromName, fromAddress: s.email.fromAddress });
  if (res.status === 'sent') {
    await ctx.db.query(`UPDATE email_outbox SET status = 'sent', provider = $2, provider_message_id = $3, attempts = attempts + 1, sent_at = now(), last_error = NULL WHERE id = $1`, [id, res.provider, res.messageId]);
  } else if (res.status === 'not_configured') {
    await ctx.db.query(`UPDATE email_outbox SET status = 'not_configured', provider = $2, attempts = attempts + 1, last_error = $3 WHERE id = $1`, [id, res.provider, res.detail]);
  } else {
    await ctx.db.query(`UPDATE email_outbox SET status = 'failed', provider = $2, attempts = attempts + 1, last_error = $3 WHERE id = $1`, [id, res.provider, res.error]);
    throw new Error(`Email delivery failed: ${res.error}`); // let the queue retry with backoff
  }
}

/** In-app notification for every member of an organization (optionally limited to roles), plus email. */
export async function notifyOrg(ctx: AppContext, orgId: string, n: { type: string; title: string; body?: string; link?: string; template?: string; vars?: Record<string, string | number | undefined>; roles?: string[] }) {
  const members = (await ctx.db.query<{ user_id: string; email: string; name: string }>(
    `SELECT m.user_id, u.email, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND u.status = 'active' AND ($2::text[] IS NULL OR m.role = ANY($2))`,
    [orgId, n.roles ?? null])).rows;
  for (const m of members) {
    await ctx.db.query('INSERT INTO notifications (user_id, org_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5, $6)', [m.user_id, orgId, n.type, n.title, n.body ?? '', n.link ?? null]);
    if (n.template) await queueEmail(ctx, m.email, n.template, { name: m.name, ...n.vars, link: n.link ? `${ctx.config.PUBLIC_SITE_URL}${n.link}` : undefined });
  }
}

/** Notify platform staff holding any of the given roles. */
export async function notifyStaff(ctx: AppContext, roles: string[], title: string, detail: string, link?: string) {
  const staff = (await ctx.db.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE platform_role = ANY($1) AND status = 'active'`, [roles])).rows;
  for (const s of staff) {
    await ctx.db.query('INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5)', [s.id, 'admin_alert', title, detail, link ?? null]);
    await queueEmail(ctx, s.email, 'admin_alert', { title, detail, link: link ? `${ctx.config.PUBLIC_SITE_URL}${link}` : '' });
  }
}
