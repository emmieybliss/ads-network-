import nodemailer from 'nodemailer';
import type { AppConfig } from '../config';

export interface OutgoingEmail { to: string; subject: string; text: string; fromName: string; fromAddress: string }
export type DeliveryResult = { status: 'sent'; provider: string; messageId: string } | { status: 'not_configured'; provider: string; detail: string } | { status: 'failed'; provider: string; error: string };

/**
 * Email provider abstraction. The outbox records the true outcome: a message
 * is marked "sent" only when the provider accepted it. With EMAIL_PROVIDER=log
 * (development) messages are written to the log and marked not_configured.
 */
export interface Mailer {
  readonly name: string;
  readonly configured: boolean;
  deliver(m: OutgoingEmail): Promise<DeliveryResult>;
}

class SmtpMailer implements Mailer {
  readonly name = 'smtp';
  readonly configured = true;
  private transport;
  constructor(cfg: AppConfig) {
    this.transport = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT ?? 587,
      secure: cfg.SMTP_SECURE,
      auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
    });
  }
  async deliver(m: OutgoingEmail): Promise<DeliveryResult> {
    try {
      const info = await this.transport.sendMail({ from: { name: m.fromName, address: m.fromAddress }, to: m.to, subject: m.subject, text: m.text });
      return { status: 'sent', provider: this.name, messageId: String(info.messageId ?? '') };
    } catch (err) {
      return { status: 'failed', provider: this.name, error: (err as Error).message.slice(0, 500) };
    }
  }
}

class LogMailer implements Mailer {
  readonly name = 'log';
  readonly configured = false;
  constructor(private log: (obj: object, msg: string) => void) {}
  async deliver(m: OutgoingEmail): Promise<DeliveryResult> {
    this.log({ to: m.to, subject: m.subject, body: m.text }, 'email (development log provider, not delivered)');
    return { status: 'not_configured', provider: this.name, detail: 'EMAIL_PROVIDER=log: message logged, not delivered' };
  }
}

class DisabledMailer implements Mailer {
  readonly name = 'disabled';
  readonly configured = false;
  async deliver(): Promise<DeliveryResult> {
    return { status: 'not_configured', provider: this.name, detail: 'Email delivery is disabled' };
  }
}

export function createMailer(cfg: AppConfig, log: (obj: object, msg: string) => void): Mailer {
  if (cfg.EMAIL_PROVIDER === 'smtp') {
    if (!cfg.SMTP_HOST) throw new Error('EMAIL_PROVIDER=smtp requires SMTP_HOST');
    return new SmtpMailer(cfg);
  }
  if (cfg.EMAIL_PROVIDER === 'log') return new LogMailer(log);
  return new DisabledMailer();
}

export const EMAIL_TEMPLATES: Record<string, { subject: string; body: string }> = {
  verify_email: { subject: 'Verify your email for {{productName}}', body: 'Hello {{name}},\n\nConfirm your email address by opening this link:\n{{link}}\n\nThe link expires in 24 hours. If you did not create an account, ignore this message.\n\n{{companyName}}' },
  reset_password: { subject: 'Reset your {{productName}} password', body: 'Hello {{name}},\n\nA password reset was requested for your account. Open this link to choose a new password:\n{{link}}\n\nThe link expires in 1 hour. If you did not request this, you can ignore this message; your password is unchanged.\n\n{{companyName}}' },
  invitation: { subject: 'You have been invited to {{orgName}} on {{productName}}', body: '{{inviterName}} invited you to join {{orgName}} as {{role}}.\n\nAccept the invitation:\n{{link}}\n\nThe invitation expires in 7 days.' },
  campaign_approved: { subject: 'Campaign approved: {{campaignName}}', body: 'Your campaign "{{campaignName}}" was approved and will deliver according to its schedule.\n\n{{link}}' },
  campaign_rejected: { subject: 'Campaign needs changes: {{campaignName}}', body: 'Your campaign "{{campaignName}}" was not approved.\n\nReason: {{reason}}\n\nUpdate it and resubmit:\n{{link}}' },
  creative_approved: { subject: 'Creative approved: {{creativeName}}', body: 'The creative "{{creativeName}}" was approved.\n\n{{link}}' },
  creative_rejected: { subject: 'Creative rejected: {{creativeName}}', body: 'The creative "{{creativeName}}" was rejected.\n\nReason: {{reason}}\n\n{{link}}' },
  site_verified: { subject: 'Domain verified: {{domain}}', body: 'Ownership of {{domain}} was verified. {{nextStep}}\n\n{{link}}' },
  site_reviewed: { subject: 'Site review result: {{domain}}', body: 'Your site {{domain}} was {{decision}}.\n{{reason}}\n\n{{link}}' },
  org_reviewed: { subject: 'Account review result for {{orgName}}', body: 'Your {{orgType}} account "{{orgName}}" was {{decision}}.\n{{reason}}\n\n{{link}}' },
  budget_alert: { subject: 'Budget alert: {{campaignName}}', body: 'Campaign "{{campaignName}}" has used {{percent}}% of its lifetime budget.\n\n{{link}}' },
  low_balance: { subject: 'Low account balance', body: 'Your unreserved account balance is {{balance}}. Add funds to keep launching campaigns.\n\n{{link}}' },
  payment_confirmed: { subject: 'Payment received: {{amount}}', body: 'We confirmed your payment of {{amount}}. The funds are available in your account.\n\nReceipt: {{link}}' },
  payout_status: { subject: 'Payout {{status}}: {{amount}}', body: 'Your payout request for {{amount}} is now {{status}}.\n{{reason}}\n\n{{link}}' },
  suspicious_activity: { subject: 'Security notice for your {{productName}} account', body: '{{detail}}\n\nIf this was not you, reset your password and contact {{supportEmail}}.' },
  admin_alert: { subject: '[Admin] {{title}}', body: '{{detail}}\n\n{{link}}' },
};

export function renderTemplate(tpl: { subject: string; body: string }, vars: Record<string, string | number | undefined>) {
  const sub = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ''));
  return { subject: sub(tpl.subject).replace(/[\r\n]+/g, ' ').slice(0, 200), text: sub(tpl.body) };
}
