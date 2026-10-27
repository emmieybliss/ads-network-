'use client';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, DefinitionList, Field, Input, ReasonDialog, Select } from '@/components/ui';
import { SimpleTable } from '@/components/admin/kit';
import { patch } from '@/lib/api';
import { formatDate, formatMicros, formatNumber, microsToInput } from '@/lib/format';

type Org = {
  id: string; type: 'advertiser' | 'publisher'; currency: string; tier: 'standard' | 'premium'; earnings_mode: 'floor' | 'guarantee' | null;
  min_cpm_micros: string | null; min_cpc_micros: string | null; guarantee_monthly_cap_micros: string | null; premium_advertisers_only: boolean;
  guarantees?: Array<{ day: string; impressions: string; clicks: string; earned_micros: string; required_micros: string; topup_micros: string; capped: boolean }>;
};

const MODE_LABEL = { none: 'No minimum', floor: 'Price floor', guarantee: 'Network-funded guarantee' } as const;

/**
 * Premium tier for any organization, plus a premium publisher's earnings
 * minimum. The API enforces every rule here; the form only mirrors them.
 */
export function PremiumCard({ org, canEdit, onSaved }: { org: Org; canEdit: boolean; onSaved: () => void }) {
  const money = (v: string | null) => (v ? formatMicros(v, org.currency) : '—');
  const pub = org.type === 'publisher';
  const [f, setF] = useState({
    tier: org.tier, mode: (org.earnings_mode ?? 'none') as keyof typeof MODE_LABEL,
    minCpm: microsToInput(org.min_cpm_micros), minCpc: microsToInput(org.min_cpc_micros),
    cap: microsToInput(org.guarantee_monthly_cap_micros), premiumOnly: org.premium_advertisers_only,
  });
  const [open, setOpen] = useState(false);
  const premium = f.tier === 'premium';
  const err = !pub || !premium || f.mode === 'none' ? null
    : !f.minCpm && !f.minCpc ? 'Set a minimum per 1,000 impressions, per click, or both.'
    : f.mode === 'guarantee' && !f.cap ? 'A guarantee needs a monthly cap.' : null;

  return (
    <Card className={pub ? 'lg:col-span-2' : undefined}>
      <CardHeader title={<span className="flex items-center gap-2">Premium {org.tier === 'premium' ? <Badge tone="info">Premium</Badge> : <Badge>Standard</Badge>}</span>}
        description={pub ? 'Premium publishers can get a minimum they earn per 1,000 impressions and per click.' : 'Premium advertisers can buy inventory that premium publishers reserve for them.'} />
      <DefinitionList items={[
        ['Tier', org.tier === 'premium' ? 'Premium' : 'Standard'],
        ...(pub ? [
          ['Earnings minimum', MODE_LABEL[org.earnings_mode ?? 'none']],
          ['Minimum per 1,000 impressions', money(org.min_cpm_micros)],
          ['Minimum per click', money(org.min_cpc_micros)],
          ...(org.earnings_mode === 'guarantee' ? [['Monthly top-up cap', money(org.guarantee_monthly_cap_micros)]] : []),
          ['Premium advertisers only', org.premium_advertisers_only ? 'Yes' : 'No'],
        ] as Array<[string, string]> : []),
      ]} />

      {canEdit && (
        <div className="mt-4 max-w-2xl space-y-3 border-t border-border pt-4">
          <Field label="Tier" htmlFor="tier">
            <Select id="tier" value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value as Org['tier'], ...(e.target.value === 'standard' ? { mode: 'none', premiumOnly: false } : {}) })}>
              <option value="standard">Standard</option><option value="premium">Premium</option>
            </Select>
          </Field>
          {pub && premium && (
            <>
              <Field label="Earnings minimum" htmlFor="mode" hint={f.mode === 'floor'
                ? 'Only ads whose publisher share meets the minimum are served here. Fewer ads may fill.'
                : f.mode === 'guarantee' ? 'All eligible ads serve. If daily earnings fall short, the network pays the difference from its own funds, up to the monthly cap.' : undefined}>
                <Select id="mode" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as typeof f.mode })}>
                  {(Object.keys(MODE_LABEL) as Array<keyof typeof MODE_LABEL>).map((k) => <option key={k} value={k}>{MODE_LABEL[k]}</option>)}
                </Select>
              </Field>
              {f.mode !== 'none' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={`Min per 1,000 impressions (${org.currency})`} htmlFor="mcpm" hint="Publisher share, e.g. 10.00"><Input id="mcpm" inputMode="decimal" value={f.minCpm} onChange={(e) => setF({ ...f, minCpm: e.target.value })} /></Field>
                  <Field label={`Min per click (${org.currency})`} htmlFor="mcpc" hint="Publisher share. Empty for none."><Input id="mcpc" inputMode="decimal" value={f.minCpc} onChange={(e) => setF({ ...f, minCpc: e.target.value })} /></Field>
                  {f.mode === 'guarantee' && <Field label={`Monthly top-up cap (${org.currency})`} htmlFor="gcap" hint="Most the network will pay this publisher in top-ups per month."><Input id="gcap" inputMode="decimal" value={f.cap} onChange={(e) => setF({ ...f, cap: e.target.value })} /></Field>}
                </div>
              )}
              <Checkbox label="Premium advertisers only" hint="Only campaigns from premium advertisers serve on this publisher's sites." checked={f.premiumOnly} onChange={(v) => setF({ ...f, premiumOnly: v })} />
            </>
          )}
          {err && <Alert tone="warning">{err}</Alert>}
          <Button size="sm" variant="secondary" disabled={!!err} onClick={() => setOpen(true)}>Save premium settings</Button>
        </div>
      )}

      {pub && org.earnings_mode === 'guarantee' && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium">Guarantee top-ups</h3>
          <SimpleTable rows={org.guarantees ?? []} rowKey={(r) => r.day} columns={[
            { key: 'd', header: 'Day', cell: (r) => formatDate(r.day) },
            { key: 'i', header: 'Impressions', align: 'right', cell: (r) => formatNumber(r.impressions) },
            { key: 'c', header: 'Clicks', align: 'right', cell: (r) => formatNumber(r.clicks) },
            { key: 'e', header: 'Earned', align: 'right', cell: (r) => money(r.earned_micros) },
            { key: 'q', header: 'Minimum', align: 'right', cell: (r) => money(r.required_micros) },
            { key: 't', header: 'Top-up', align: 'right', cell: (r) => <>{money(r.topup_micros)}{r.capped && <Badge tone="warning" className="ml-1">Capped</Badge>}</> },
          ]} />
        </div>
      )}

      <ReasonDialog open={open} onClose={() => setOpen(false)} title="Change premium settings" confirmLabel="Save"
        description={pub && f.mode === 'guarantee' ? 'Top-ups are paid from network funds and recorded in the ledger.' : undefined}
        onConfirm={async (reason) => {
          const on = pub && premium && f.mode !== 'none';
          await patch(`/admin/orgs/${org.id}/premium`, {
            tier: f.tier,
            earningsMode: on ? f.mode : null,
            minCpm: on && f.minCpm ? f.minCpm : null,
            minCpc: on && f.minCpc ? f.minCpc : null,
            guaranteeMonthlyCap: on && f.mode === 'guarantee' ? f.cap : null,
            premiumAdvertisersOnly: pub && premium && f.premiumOnly,
            reason,
          });
          setOpen(false);
          onSaved();
        }} />
    </Card>
  );
}
