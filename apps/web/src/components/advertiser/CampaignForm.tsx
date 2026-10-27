'use client';
import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Alert, Button, Card, CardHeader, Checkbox, Field, Input, Select } from '@/components/ui';
import { useConfig } from '@/lib/hooks';
import { errorMessage } from '@/lib/api';
import { formatMicros, microsToInput } from '@/lib/format';

export interface CampaignPayload {
  name: string;
  pricingModel: 'cpm' | 'cpc' | 'flat';
  rate: string;
  lifetimeBudget: string;
  dailyBudget: string | null;
  maxImpressions: number | null;
  maxClicks: number | null;
  timezone: string;
  startAt: string;
  endAt: string | null;
  pacing: 'even' | 'asap';
  priority: number;
  targeting: { countries: string[]; devices: string[]; siteCategories: string[]; keywords: string[]; requirePersonalized: boolean };
  caps: Array<{ scope: 'visitor' | 'page'; maxImpressions: number; windowSeconds: number }>;
}

const DEVICES = ['desktop', 'mobile', 'tablet', 'other'] as const;
const WINDOWS: Array<[number, string]> = [[3600, '1 hour'], [21_600, '6 hours'], [86_400, '1 day'], [604_800, '7 days']];

const list = (s: string, upper = false) => s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (upper ? x.toUpperCase() : x));
/** `datetime-local` value in the browser's zone → ISO string with offset. */
const toIso = (local: string) => (local ? new Date(local).toISOString() : '');
const toLocal = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/** Campaign settings form, used to create a campaign and to edit one. */
export function CampaignForm({ initial, submitLabel, onSubmit, lockedPricing }: { initial?: Record<string, any>; submitLabel: string; onSubmit: (p: CampaignPayload) => Promise<void>; lockedPricing?: boolean }) {
  const cfg = useConfig().data?.data;
  const t = initial?.targeting ?? {};
  const [f, setF] = useState({
    name: initial?.name ?? '',
    pricingModel: (initial?.pricingModel ?? 'cpm') as CampaignPayload['pricingModel'],
    rate: microsToInput(initial?.rateMicros),
    lifetimeBudget: microsToInput(initial?.lifetimeBudgetMicros),
    dailyBudget: microsToInput(initial?.dailyBudgetMicros),
    maxImpressions: initial?.maxImpressions ? String(initial.maxImpressions) : '',
    maxClicks: initial?.maxClicks ? String(initial.maxClicks) : '',
    timezone: initial?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
    startAt: toLocal(initial?.startAt ?? new Date(Date.now() + 3_600_000).toISOString()),
    endAt: toLocal(initial?.endAt),
    pacing: (initial?.pacing ?? 'even') as 'even' | 'asap',
    priority: String(initial?.priority ?? 5),
    countries: (t.countries ?? []).join(', '),
    devices: (t.devices ?? []) as string[],
    siteCategories: (t.siteCategories ?? []).join(', '),
    keywords: (t.keywords ?? []).join(', '),
    requirePersonalized: !!t.requirePersonalized,
  });
  const [caps, setCaps] = useState<CampaignPayload['caps']>(initial?.caps ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (f.pricingModel === 'flat' && f.lifetimeBudget !== f.rate) return setError('For a flat-rate sponsorship the lifetime budget equals the sponsorship price.');
    setBusy(true);
    try {
      await onSubmit({
        name: f.name.trim(),
        pricingModel: f.pricingModel,
        rate: f.rate,
        lifetimeBudget: f.pricingModel === 'flat' ? f.rate : f.lifetimeBudget,
        dailyBudget: f.dailyBudget || null,
        maxImpressions: f.maxImpressions ? Number(f.maxImpressions) : null,
        maxClicks: f.maxClicks ? Number(f.maxClicks) : null,
        timezone: f.timezone,
        startAt: toIso(f.startAt),
        endAt: f.endAt ? toIso(f.endAt) : null,
        pacing: f.pacing,
        priority: Number(f.priority),
        targeting: { countries: list(f.countries, true), devices: f.devices, siteCategories: list(f.siteCategories), keywords: list(f.keywords), requirePersonalized: f.requirePersonalized },
        caps,
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const rateLabel = f.pricingModel === 'cpm' ? 'Price per 1,000 valid impressions' : f.pricingModel === 'cpc' ? 'Price per valid click' : 'Sponsorship price';
  const minHint = cfg && (f.pricingModel === 'cpm' ? `Minimum ${formatMicros(cfg.pricing.minCpmMicros)}` : f.pricingModel === 'cpc' ? `Minimum ${formatMicros(cfg.pricing.minCpcMicros)}` : undefined);

  return (
    <form onSubmit={submit} className="space-y-5">
      {error && <Alert tone="danger" title="Could not save the campaign">{error}</Alert>}
      <Card>
        <CardHeader title="Basics" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Campaign name" htmlFor="name" required className="sm:col-span-2"><Input id="name" required maxLength={160} value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Pricing model" htmlFor="pm" hint={lockedPricing ? 'The pricing model cannot change after submission.' : undefined}>
            <Select id="pm" value={f.pricingModel} disabled={lockedPricing} onChange={(e) => set('pricingModel', e.target.value as CampaignPayload['pricingModel'])}>
              {(!cfg || cfg.pricing.cpmEnabled) && <option value="cpm">CPM (per 1,000 valid impressions)</option>}
              {(!cfg || cfg.pricing.cpcEnabled) && <option value="cpc">CPC (per valid click)</option>}
              {(!cfg || cfg.pricing.flatEnabled) && <option value="flat">Flat-rate sponsorship</option>}
            </Select>
          </Field>
          <Field label={rateLabel} htmlFor="rate" hint={minHint} required><Input id="rate" inputMode="decimal" required pattern="^\d+(\.\d{1,6})?$" value={f.rate} onChange={(e) => set('rate', e.target.value)} placeholder="0.00" /></Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Budget and schedule" description="Spend never exceeds the lifetime budget. Budget is reserved from your balance when you submit." />
        <div className="grid gap-4 sm:grid-cols-2">
          {f.pricingModel !== 'flat' && (
            <Field label="Lifetime budget" htmlFor="lb" required hint={cfg ? `Minimum ${formatMicros(cfg.pricing.minCampaignBudgetMicros)}` : undefined}><Input id="lb" inputMode="decimal" required pattern="^\d+(\.\d{1,2})?$" value={f.lifetimeBudget} onChange={(e) => set('lifetimeBudget', e.target.value)} placeholder="0.00" /></Field>
          )}
          {f.pricingModel !== 'flat' && <Field label="Daily budget" htmlFor="db" hint="Optional"><Input id="db" inputMode="decimal" pattern="^\d+(\.\d{1,2})?$" value={f.dailyBudget} onChange={(e) => set('dailyBudget', e.target.value)} placeholder="No daily limit" /></Field>}
          <Field label="Start" htmlFor="sa" required><Input id="sa" type="datetime-local" required value={f.startAt} onChange={(e) => set('startAt', e.target.value)} /></Field>
          <Field label="End" htmlFor="ea" hint={f.pricingModel === 'flat' ? 'Required for sponsorships' : 'Optional'}><Input id="ea" type="datetime-local" required={f.pricingModel === 'flat'} value={f.endAt} min={f.startAt} onChange={(e) => set('endAt', e.target.value)} /></Field>
          <Field label="Time zone for daily budgets" htmlFor="tz"><Input id="tz" value={f.timezone} onChange={(e) => set('timezone', e.target.value)} /></Field>
          <Field label="Pacing" htmlFor="pace">
            <Select id="pace" value={f.pacing} onChange={(e) => set('pacing', e.target.value as 'even' | 'asap')}>
              <option value="even">Even (spread across the day)</option>
              <option value="asap">As fast as possible</option>
            </Select>
          </Field>
          <Field label="Maximum valid impressions" htmlFor="mi" hint="Optional"><Input id="mi" type="number" min={1} value={f.maxImpressions} onChange={(e) => set('maxImpressions', e.target.value)} /></Field>
          <Field label="Maximum valid clicks" htmlFor="mc" hint="Optional"><Input id="mc" type="number" min={1} value={f.maxClicks} onChange={(e) => set('maxClicks', e.target.value)} /></Field>
          <Field label="Priority" htmlFor="pri" hint="1 (lowest) to 10 (highest), used only to order eligible campaigns at the same price.">
            <Input id="pri" type="number" min={1} max={10} value={f.priority} onChange={(e) => set('priority', e.target.value)} />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Targeting" description="Leave a field empty to include everything. Targeting narrows where ads are eligible; it does not guarantee delivery." />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Countries" htmlFor="ct" hint="Two-letter codes, comma separated, for example US, GB"><Input id="ct" value={f.countries} onChange={(e) => set('countries', e.target.value)} /></Field>
          <Field label="Site categories" htmlFor="sc" hint="Comma separated"><Input id="sc" value={f.siteCategories} onChange={(e) => set('siteCategories', e.target.value)} /></Field>
          <Field label="Keywords" htmlFor="kw" hint="Matched against placement keywords" className="sm:col-span-2"><Input id="kw" value={f.keywords} onChange={(e) => set('keywords', e.target.value)} /></Field>
          <fieldset className="sm:col-span-2">
            <legend className="mb-2 text-sm font-medium">Devices</legend>
            <div className="flex flex-wrap gap-4">
              {DEVICES.map((d) => <Checkbox key={d} label={d[0]!.toUpperCase() + d.slice(1)} checked={f.devices.includes(d)} onChange={(v) => set('devices', v ? [...f.devices, d] : f.devices.filter((x) => x !== d))} />)}
            </div>
          </fieldset>
          <div className="sm:col-span-2">
            <Checkbox label="Only serve where the visitor has consented to personalized ads" checked={f.requirePersonalized} onChange={(v) => set('requirePersonalized', v)} hint="Consent decisions come from the publisher page. They are never overridden." />
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Frequency caps" description="Limit how often the same visitor or page sees this campaign." actions={caps.length < 5 && <Button size="sm" variant="secondary" onClick={() => setCaps([...caps, { scope: 'visitor', maxImpressions: 3, windowSeconds: 86_400 }])}><Plus className="size-4" /> Add cap</Button>} />
        {caps.length === 0 ? <p className="text-sm text-muted">No frequency caps.</p> : (
          <div className="space-y-3">
            {caps.map((c, i) => (
              <div key={i} className="flex flex-wrap items-end gap-3">
                <Field label="Scope" htmlFor={`cs${i}`}><Select id={`cs${i}`} value={c.scope} onChange={(e) => setCaps(caps.map((x, j) => (j === i ? { ...x, scope: e.target.value as 'visitor' | 'page' } : x)))}><option value="visitor">Per visitor</option><option value="page">Per page view</option></Select></Field>
                <Field label="Impressions" htmlFor={`cm${i}`}><Input id={`cm${i}`} type="number" min={1} className="w-28" value={c.maxImpressions} onChange={(e) => setCaps(caps.map((x, j) => (j === i ? { ...x, maxImpressions: Number(e.target.value) } : x)))} /></Field>
                <Field label="Per" htmlFor={`cw${i}`}><Select id={`cw${i}`} value={c.windowSeconds} onChange={(e) => setCaps(caps.map((x, j) => (j === i ? { ...x, windowSeconds: Number(e.target.value) } : x)))}>{WINDOWS.map(([s, l]) => <option key={s} value={s}>{l}</option>)}</Select></Field>
                <Button variant="ghost" size="sm" aria-label="Remove cap" onClick={() => setCaps(caps.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="submit" loading={busy}>{submitLabel}</Button>
      </div>
    </form>
  );
}
