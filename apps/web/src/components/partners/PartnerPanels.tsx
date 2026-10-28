'use client';
import { useEffect, useState } from 'react';
import { Network, Save } from 'lucide-react';
import { Alert, Async, Badge, Button, Card, CardHeader, Checkbox, EmptyState, Input, StatusBadge, Table } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { errorMessage, put } from '@/lib/api';
import { formatMicros, formatNumber, formatPercent, timeAgo } from '@/lib/format';

export interface PartnerCampaign {
  id: string; networkId: string; networkName: string; budgetPercent: number; status: string; statusReason: string | null;
  impressions: number; clicks: number; spendMicros: string; lastSyncedAt: string | null;
  ads: Array<{ creativeId: string; name: string; version: number; status: string; rejectionReason: string | null }>;
  externalId?: string | null; markupPercent?: number; costMicros?: string; absorbedMicros?: string; adminHold?: boolean; adminHoldReason?: string | null;
}
interface Offered { id: string; name: string; website: string | null; simulated: boolean; serviceFeePercent: number; minCpcMicros: string }

/** Where each partner campaign stands, its ads as the partner reviewed them, and what it delivered. */
export function PartnerStatusList({ partners, currency, actions }: { partners: PartnerCampaign[]; currency: string; actions?: (p: PartnerCampaign) => React.ReactNode }) {
  const money = (v: string | null | undefined) => formatMicros(v, currency);
  if (!partners.length) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {partners.map((p) => (
        <div key={p.id} className="rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-medium">{p.networkName} <StatusBadge status={p.status} />{p.adminHold && <Badge tone="warning">Held</Badge>}</p>
              <p className="mt-0.5 text-xs text-muted">Up to {p.budgetPercent}% of the budget{p.lastSyncedAt ? ` · synced ${timeAgo(p.lastSyncedAt)}` : ' · not synced yet'}{p.externalId ? ` · partner id ${p.externalId}` : ''}</p>
            </div>
            {actions?.(p)}
          </div>
          {p.statusReason && <p className="mt-2 text-sm text-fg-2">{p.statusReason}</p>}
          <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <div><dt className="text-xs text-muted">Impressions</dt><dd className="tabular font-medium">{formatNumber(p.impressions)}</dd></div>
            <div><dt className="text-xs text-muted">Clicks</dt><dd className="tabular font-medium">{formatNumber(p.clicks)}</dd></div>
            <div><dt className="text-xs text-muted">Spend</dt><dd className="tabular font-medium">{money(p.spendMicros)}</dd></div>
            {p.costMicros !== undefined && <>
              <div><dt className="text-xs text-muted">Partner cost</dt><dd className="tabular">{money(p.costMicros)}</dd></div>
              <div><dt className="text-xs text-muted">Margin ({p.markupPercent}% markup)</dt><dd className="tabular">{money(String(BigInt(p.spendMicros) - BigInt(p.costMicros)))}</dd></div>
              <div><dt className="text-xs text-muted">Absorbed</dt><dd className="tabular">{money(p.absorbedMicros)}</dd></div>
            </>}
          </dl>
          {p.ads.length > 0 && (
            <ul className="mt-3 space-y-1.5 border-t border-border pt-3">
              {p.ads.map((a) => (
                <li key={a.creativeId} className="text-sm">
                  <span className="flex items-center justify-between gap-2"><span className="truncate">{a.name} <span className="text-xs text-muted">v{a.version}</span></span><StatusBadge status={a.status} label={a.status === 'approved' ? 'Approved by partner' : a.status === 'in_review' ? 'Partner reviewing' : undefined} /></span>
                  {a.rejectionReason && <span className="mt-0.5 block text-xs text-danger">{a.rejectionReason}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

/** Advertiser: choose partner networks for a CPC campaign and see how each is doing. */
export function PartnerDistribution({ orgId, campaignId, currency, editable }: { orgId: string; campaignId: string; currency: string; editable: boolean }) {
  const offered = useApi<{ data: Offered[] }>(`/orgs/${orgId}/partner-networks`);
  const state = useApi<{ data: { eligibility: { ok: boolean; reasons: string[]; nativeAdsApproved: number }; partners: PartnerCampaign[] } }>(`/orgs/${orgId}/campaigns/${campaignId}/partners`);
  const [choice, setChoice] = useState<Record<string, number | null>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!state.data) return;
    const next: Record<string, number | null> = {};
    for (const p of state.data.data.partners) if (p.status !== 'stopped') next[p.networkId] = p.budgetPercent;
    setChoice(next);
  }, [state.data]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const networks = Object.entries(choice).filter(([, v]) => v !== null).map(([networkId, v]) => ({ networkId, budgetPercent: Number(v) }));
      await put(`/orgs/${orgId}/campaigns/${campaignId}/partners`, { networks });
      state.reload();
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const total = Object.values(choice).reduce<number>((s, v) => s + (v ?? 0), 0);
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Also run on partner networks" description="BlissNova can run this campaign on outside native networks from its own partner accounts, alongside the BlissNova network. You pay what the partner charges plus BlissNova’s service fee, never more than your CPC per click, and spend comes out of this campaign’s budget." />
        <Async res={state}>
          {({ data }) => (
            <Async res={offered}>
              {({ data: nets }) => (
                <>
                  {!data.eligibility.ok && <Alert tone="info" className="mb-4" title="This campaign can’t use partner networks yet">{data.eligibility.reasons.join(' ')}</Alert>}
                  {nets.length === 0 ? <EmptyState icon={<Network className="size-6" />} title="No partner networks are available yet">BlissNova is setting up partner accounts. Once a network is connected it will appear here.</EmptyState> : (
                    <div className="divide-y divide-border">
                      {nets.map((n) => {
                        const on = choice[n.id] !== undefined && choice[n.id] !== null;
                        return (
                          <div key={n.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                            <Checkbox
                              label={<span className="flex items-center gap-2 font-medium">{n.name}{n.simulated && <Badge tone="accent">Demo only</Badge>}</span>}
                              hint={`Service fee ${n.serviceFeePercent}% on top of partner cost · minimum CPC ${formatMicros(n.minCpcMicros, currency)}`}
                              checked={on} disabled={!editable || !data.eligibility.ok}
                              onChange={(v) => setChoice({ ...choice, [n.id]: v ? 30 : null })} />
                            {on && (
                              <label className="flex items-center gap-2 whitespace-nowrap text-sm text-fg-2">Up to
                                <Input type="number" min={1} max={100} value={choice[n.id] ?? ''} disabled={!editable} onChange={(e) => setChoice({ ...choice, [n.id]: Number(e.target.value) })} style={{ width: '5.5rem' }} aria-label={`Budget share for ${n.name}`} />
                                % of the budget
                              </label>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {total > 100 && <Alert tone="warning" className="mt-3">Partner shares add up to {total}%. Keep the total at 100% or less.</Alert>}
                  {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
                  {saved && !error && <Alert tone="success" className="mt-3">Saved. Partner networks update within a minute.</Alert>}
                  {editable && nets.length > 0 && <div className="mt-4"><Button onClick={save} loading={saving} disabled={total > 100 || (!data.eligibility.ok && Object.keys(choice).length === 0)}><Save className="size-4" /> Save partner networks</Button></div>}
                </>
              )}
            </Async>
          )}
        </Async>
      </Card>
      {state.data && state.data.data.partners.length > 0 && (
        <Card>
          <CardHeader title="Partner delivery" description="Each partner reviews ads under its own policies, so an ad approved by BlissNova can still be rejected there." />
          <PartnerStatusList partners={state.data.data.partners} currency={currency} />
        </Card>
      )}
    </div>
  );
}

interface SourceRow { source: string; name: string; impressions: number; clicks: number; conversions: number | null; spendMicros: string; ctr: number | null; cpcMicros: string | null; costMicros?: string; marginMicros?: string }

/** Delivery and spend by source: the BlissNova network and each partner network. */
export function SourceReport({ path, currency, title = 'By source' }: { path: string; currency: string; title?: string }) {
  const res = useApi<{ data: { range: { from: string; to: string }; rows: SourceRow[] } }>(path);
  const money = (v: string | null | undefined) => (v ? formatMicros(v, currency) : '—');
  return (
    <Card>
      <Async res={res}>
        {({ data }) => {
          const admin = data.rows.some((r) => r.costMicros !== undefined);
          return (
            <>
              <CardHeader title={title} description={`${data.range.from} to ${data.range.to}. BlissNova counts validated impressions and clicks; partner networks report their own.`} />
              <Table rows={data.rows} rowKey={(r) => r.source} columns={[
                { key: 'n', header: 'Source', cell: (r) => <span className="font-medium">{r.name}</span> },
                { key: 'i', header: 'Impressions', align: 'right', cell: (r) => formatNumber(r.impressions) },
                { key: 'c', header: 'Clicks', align: 'right', cell: (r) => formatNumber(r.clicks) },
                { key: 't', header: 'CTR', align: 'right', cell: (r) => (r.ctr === null ? '—' : formatPercent(r.ctr)) },
                { key: 'v', header: 'Conversions', align: 'right', cell: (r) => (r.conversions === null ? '—' : formatNumber(r.conversions)) },
                { key: 's', header: 'Spend', align: 'right', cell: (r) => money(r.spendMicros) },
                { key: 'p', header: 'Avg. CPC', align: 'right', cell: (r) => money(r.cpcMicros) },
                ...(admin ? [
                  { key: 'k', header: 'Partner cost', align: 'right' as const, cell: (r: SourceRow) => money(r.costMicros) },
                  { key: 'm', header: 'Margin', align: 'right' as const, cell: (r: SourceRow) => money(r.marginMicros) },
                ] : []),
              ]} />
            </>
          );
        }}
      </Async>
    </Card>
  );
}
