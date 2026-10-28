import type { Pool } from 'pg';
import { formatMoney } from '@blissnova/shared';
import { runReport, type ReportScope } from './reports';
import { previousRange } from './analytics';

export type ReportFrequency = 'daily' | 'weekly' | 'monthly';
export interface ReportPeriod { from: string; to: string; label: string }
type Org = { id: string; type: 'advertiser' | 'publisher'; currency: string; name: string };

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const FREQUENCY_LABEL: Record<ReportFrequency, string> = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' };

/**
 * The most recent complete period (UTC) for a frequency: yesterday, last
 * Monday to Sunday, or last calendar month.
 */
export function latestPeriod(freq: ReportFrequency, now = new Date()): ReportPeriod {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (freq === 'daily') {
    const d = iso(today - DAY);
    return { from: d, to: d, label: d };
  }
  if (freq === 'weekly') {
    const dow = (new Date(today).getUTCDay() + 6) % 7; // 0 = Monday
    const to = today - (dow + 1) * DAY;
    return { from: iso(to - 6 * DAY), to: iso(to), label: `${iso(to - 6 * DAY)} to ${iso(to)}` };
  }
  const first = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const last = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0);
  const m = new Date(first);
  return { from: iso(first), to: iso(last), label: `${MONTHS[m.getUTCMonth()]} ${m.getUTCFullYear()}` };
}

/** When the next scheduled email goes out: 01:00 UTC on the first day whose latest complete period has not been sent. */
export function nextSendAt(freq: ReportFrequency, lastPeriodEnd: string | null, now = new Date()): string {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = 0; i <= 32; i++) {
    const at = day + i * DAY + 3_600_000;
    if (!lastPeriodEnd || latestPeriod(freq, new Date(at)).to > lastPeriodEnd) return new Date(Math.max(at, now.getTime())).toISOString();
  }
  return new Date(day + 33 * DAY + 3_600_000).toISOString();
}

const COUNTRY = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (c: string) => { if (c === 'ZZ') return 'Unknown'; try { return COUNTRY.of(c) ?? c; } catch { return c; } };
const num = (n: unknown) => Number(n ?? 0).toLocaleString('en-US');
const pct = (n: unknown, d = 2) => (n === null || n === undefined ? '-' : `${Number(n).toFixed(d)}%`);
function change(now: unknown, before: unknown): string {
  const a = Number(now ?? 0);
  const b = Number(before ?? 0);
  if (!b) return a ? 'new' : 'no change';
  const p = ((a - b) / Math.abs(b)) * 100;
  return Math.abs(p) < 0.05 ? 'no change' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
}
const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s + ' '.repeat(n - s.length));

/**
 * Plain-text performance summary for one organization and period: headline
 * numbers with the change from the period before, the top countries and the
 * top websites (publishers) or campaigns (advertisers). Validated events only.
 */
export async function buildPerformanceReport(db: Pool, org: Org, period: ReportPeriod): Promise<string> {
  const scope: ReportScope = org.type === 'advertiser' ? { advertiserOrgId: org.id } : { publisherOrgId: org.id };
  const f = { from: period.from, to: period.to };
  const prev = previousRange(f);
  const [cur, before, countries, items] = await Promise.all([
    runReport(db, scope, f, 'day', org.type),
    runReport(db, scope, { from: prev.from, to: prev.to }, 'day', org.type),
    runReport(db, scope, f, 'country', org.type, 5),
    runReport(db, scope, f, org.type === 'advertiser' ? 'campaign' : 'site', org.type, 5),
  ]);
  const t = cur.totals as Record<string, any>;
  const p = before.totals as Record<string, any>;
  const money = (v: unknown) => formatMoney(String(v ?? '0'), org.currency);
  const pub = org.type === 'publisher';
  const moneyKey = pub ? 'earningsMicros' : 'spendMicros';
  const rows: Array<[string, string, string]> = [
    [pub ? 'Estimated earnings' : 'Spend', money(t[moneyKey]), change(t[moneyKey], p[moneyKey])],
    ['Valid impressions', num(t.validImpressions), change(t.validImpressions, p.validImpressions)],
    ['Valid clicks', num(t.validClicks), change(t.validClicks, p.validClicks)],
    ['CTR', pct(t.ctr), change(t.ctr, p.ctr)],
    ['Viewability', pct(t.viewabilityRate, 1), change(t.viewabilityRate, p.viewabilityRate)],
    pub ? ['RPM', t.rpmMicros ? money(t.rpmMicros) : '-', change(t.rpmMicros, p.rpmMicros)] : ['eCPM', t.ecpmMicros ? money(t.ecpmMicros) : '-', change(t.ecpmMicros, p.ecpmMicros)],
  ];
  if (!pub) rows.push(['Conversions', num(t.conversions), change(t.conversions, p.conversions)], ['CPA', t.cpaMicros ? money(t.cpaMicros) : '-', change(t.cpaMicros, p.cpaMicros)]);
  const lines = [
    `${pub ? 'Publisher' : 'Advertiser'} report for ${org.name}`,
    `Period: ${period.label} (UTC). Compared with ${prev.from} to ${prev.to}.`,
    '',
    ...rows.map(([k, v, c]) => `${pad(k, 22)}${pad(v, 18)}${c}`),
  ];
  if (!Number(t.validImpressions)) lines.push('', 'No valid impressions were recorded in this period.');
  const list = (title: string, data: Array<Record<string, any>>, label: (r: Record<string, any>) => string) => {
    if (!data.length) return;
    lines.push('', title);
    data.forEach((r, i) => lines.push(`  ${i + 1}. ${pad(label(r), 28)}${pad(`${num(r.validImpressions)} impr.`, 18)}${money(r[moneyKey])}`));
  };
  list('Top countries', countries.rows, (r) => countryName(String(r.key)));
  list(pub ? 'Top websites' : 'Top campaigns', items.rows, (r) => String(r.label ?? r.key));
  return lines.join('\n');
}

/** Reports whose latest complete period has not been emailed yet. */
export async function sendDueReports(db: Pool, send: (to: string, vars: Record<string, string>) => Promise<void>, siteUrl: string, now = new Date()) {
  // Leave an hour after midnight UTC for the day's aggregates to settle.
  if (now.getUTCHours() < 1) return 0;
  let sent = 0;
  for (const freq of ['daily', 'weekly', 'monthly'] as const) {
    const period = latestPeriod(freq, now);
    const due = (await db.query(
      `UPDATE report_subscriptions r SET last_period_end = $2::date, updated_at = now()
       FROM users u, organizations o, memberships m
       WHERE r.frequency = $1 AND (r.last_period_end IS NULL OR r.last_period_end < $2::date)
         AND u.id = r.user_id AND u.status = 'active' AND o.id = r.org_id AND o.type IN ('advertiser', 'publisher')
         AND m.user_id = r.user_id AND m.org_id = r.org_id
       RETURNING u.email, u.name, o.id, o.type, o.currency, o.name AS org_name`, [freq, period.to])).rows;
    for (const d of due) {
      const report = await buildPerformanceReport(db, { id: d.id, type: d.type, currency: d.currency, name: d.org_name }, period);
      await send(d.email, { name: d.name, orgName: d.org_name, frequencyLabel: FREQUENCY_LABEL[freq], period: period.label, report, link: `${siteUrl}/${d.type}/analytics`,
        why: `You get this email because you turned on ${FREQUENCY_LABEL[freq]} reports for ${d.org_name}. Change or stop them on the Analytics page.` });
      sent++;
    }
  }
  return sent;
}
