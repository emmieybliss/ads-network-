'use client';
import { useState } from 'react';
import { Alert, Async, Button, Card, CardHeader, CodeBlock, Field, Select, Stat } from '../ui';
import { useApi } from '@/lib/hooks';
import { errorMessage, put } from '@/lib/api';
import { formatDate, formatMicros, formatNumber } from '@/lib/format';

interface Settings { enabled: boolean; attributionWindowDays: number; currency: string; pixelUrl: string; postbackUrl: string; totals: { conversions: number; valueMicros: string; lastAt: string | null; byEvent: Array<{ event: string; conversions: number; valueMicros: string }> } }

/** Conversion tracking for one campaign: switch, attribution window, and the pixel and postback to install. */
export function ConversionTracking({ orgId, campaignId, canEdit }: { orgId: string; campaignId: string; canEdit: boolean }) {
  const path = `/orgs/${orgId}/campaigns/${campaignId}/conversion-tracking`;
  const res = useApi<{ data: Settings }>(path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(body: { enabled: boolean; attributionWindowDays?: number }) {
    setBusy(true);
    setError(null);
    try {
      await put(path, body);
      res.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Async res={res}>
      {({ data: s }) => (
        <Card>
          <CardHeader title="Conversion tracking" description="Count purchases, sign-ups and other actions that follow a valid click, and see conversion rate, CPA and ROAS in Analytics." actions={canEdit && (
            <Button variant={s.enabled ? 'secondary' : 'primary'} size="sm" loading={busy} onClick={() => save({ enabled: !s.enabled })}>{s.enabled ? 'Turn off' : 'Turn on'}</Button>
          )} />
          {error && <Alert tone="danger" className="mb-4">{error}</Alert>}
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Status" value={s.enabled ? 'On' : 'Off'} />
            <Stat label="Conversions" value={formatNumber(s.totals.conversions)} hint={s.totals.lastAt ? `Last ${formatDate(s.totals.lastAt, true)}` : undefined} />
            <Stat label="Conversion value" value={formatMicros(s.totals.valueMicros, s.currency)} />
            <Field label="Attribution window" htmlFor="aw">
              <Select id="aw" value={String(s.attributionWindowDays)} disabled={!canEdit || busy} onChange={(e) => save({ enabled: s.enabled, attributionWindowDays: Number(e.target.value) })}>
                {[1, 7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''} after the click</option>)}
              </Select>
            </Field>
          </div>
          <ol className="list-decimal space-y-3 pl-5 text-sm text-fg-2">
            <li>With tracking on, every click lands on your page with <code className="rounded bg-surface-2 px-1">bn_click_id</code> added to the address. Keep it (for example in your checkout session).</li>
            <li>
              On the confirmation page, load this pixel with the click id, or send the same fields from your server:
              <div className="mt-2"><CodeBlock label="Pixel (image request)" code={`<img src="${s.pixelUrl}" width="1" height="1" alt="" style="display:none">`} /></div>
              <div className="mt-2"><CodeBlock label="Server postback (POST JSON)" code={`POST ${s.postbackUrl}\n{ "click_id": "<bn_click_id>", "event": "purchase", "value": "49.90", "currency": "${s.currency}", "order_id": "A-1001" }`} /></div>
            </li>
            <li>Each click, event and order id counts once, so a reloaded thank-you page is not counted twice. Conversions for invalid clicks, or after the window, are refused.</li>
          </ol>
        </Card>
      )}
    </Async>
  );
}
