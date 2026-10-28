import type { Pool } from 'pg';

/**
 * Advertiser conversion tracking (the click-id model Taboola, MGID and
 * RevContent use). With tracking on, the click redirect appends bn_click_id
 * (the delivery id) to the landing page URL. The advertiser reports a
 * conversion with that id from a browser pixel or a server postback.
 *
 * A conversion is recorded only for a click that passed invalid-traffic
 * checks, on a campaign with tracking enabled, inside the campaign's
 * attribution window. The click id is a random UUID that only the visitor's
 * browser and the landing page ever see, so a publisher cannot report
 * conversions for clicks it did not send. One conversion is kept per
 * (click, event, order id), so a reloaded thank-you page counts once.
 */
export interface ConversionInput {
  clickId: string;
  event: string;
  valueMicros: bigint;
  currency?: string;
  orderRef: string;
  method: 'pixel' | 'postback';
  now?: number;
}

export type ConversionResult =
  | { status: 'recorded'; id: string; campaignId: string }
  | { status: 'duplicate' }
  | { status: 'rejected'; reason: 'unknown_click' | 'tracking_off' | 'outside_window' | 'currency_mismatch' };

export async function recordConversion(db: Pool, input: ConversionInput): Promise<ConversionResult> {
  const click = (await db.query(
    `SELECT e.delivery_id, e.campaign_id, e.creative_id, e.advertiser_org_id, e.site_id, e.unit_id, e.publisher_org_id, e.country, e.device, e.os, e.browser, e.source, e.page_path,
            e.occurred_at, c.conversion_tracking, c.attribution_window_days, c.currency
     FROM ad_events e JOIN campaigns c ON c.id = e.campaign_id
     WHERE e.delivery_id = $1 AND e.type = 'click' AND e.status = 'valid' ORDER BY e.occurred_at LIMIT 1`, [input.clickId])).rows[0];
  if (!click) return { status: 'rejected', reason: 'unknown_click' };
  if (!click.conversion_tracking) return { status: 'rejected', reason: 'tracking_off' };
  const now = input.now ?? Date.now();
  if (now - new Date(click.occurred_at).getTime() > click.attribution_window_days * 86_400_000) return { status: 'rejected', reason: 'outside_window' };
  if (input.valueMicros > 0n && input.currency && input.currency !== click.currency) return { status: 'rejected', reason: 'currency_mismatch' };
  const r = await db.query<{ id: string }>(
    `INSERT INTO conversions (delivery_id, event_name, order_ref, value_micros, currency, method, campaign_id, creative_id, advertiser_org_id, site_id, unit_id, publisher_org_id,
       country, device, os, browser, source, page_path, click_at, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, to_timestamp($20 / 1000.0))
     ON CONFLICT (delivery_id, event_name, order_ref) DO NOTHING RETURNING id`,
    [click.delivery_id, input.event, input.orderRef, input.valueMicros.toString(), click.currency, input.method, click.campaign_id, click.creative_id, click.advertiser_org_id,
      click.site_id, click.unit_id, click.publisher_org_id, click.country, click.device, click.os, click.browser, click.source, click.page_path, click.occurred_at, now]);
  if (!r.rows[0]) return { status: 'duplicate' };
  return { status: 'recorded', id: r.rows[0].id, campaignId: click.campaign_id };
}
