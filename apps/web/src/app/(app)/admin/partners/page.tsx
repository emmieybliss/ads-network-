'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ExternalLink, PlugZap } from 'lucide-react';
import { Alert, Async, Badge, Button, Card, Field, Input, Modal, PageHeader, StatusBadge, Textarea } from '@/components/ui';
import { AdminTable } from '@/components/admin/kit';
import { SourceReport } from '@/components/partners/PartnerPanels';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { errorMessage, patch, post } from '@/lib/api';
import { formatMicros, formatNumber, microsToInput, timeAgo } from '@/lib/format';

interface Network {
  id: string; name: string; website: string | null; devOnly: boolean; enabled: boolean; available: boolean; connection: string;
  markupPercent: number; minCpcMicros: string; notes: string; lastCheck: { ok: boolean; detail: string; at: string } | null;
  liveCampaigns: number; campaigns: number; last30Days: { clicks: number; costMicros: string; chargedMicros: string; marginMicros: string; absorbedMicros: string };
}

export default function PartnerNetworks() {
  const { canAdmin } = useSession();
  const manage = canAdmin('admin:pricing:manage');
  const res = useApi<{ data: Network[] }>('/admin/partners');
  const [edit, setEdit] = useState<{ n: Network; markup: string; minCpc: string; reason: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const money = (v: string) => formatMicros(v, 'USD');

  async function toggle(n: Network) {
    setError(null);
    const reason = n.enabled ? 'Turned off from the Partner networks page' : 'Turned on from the Partner networks page';
    try { await patch(`/admin/partners/${n.id}`, { enabled: !n.enabled, reason }); res.reload(); } catch (e) { setError(errorMessage(e)); }
  }
  async function test(n: Network) {
    setBusy(n.id);
    try { await post(`/admin/partners/${n.id}/test`); res.reload(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }

  return (
    <>
      <PageHeader title="Partner networks" description="Outside native networks BlissNova buys on as an agency. Advertisers can let part of a CPC campaign run there; BlissNova pays the partner and bills the advertiser partner cost plus markup." />
      {error && <Alert tone="danger" className="mb-4">{error}</Alert>}
      <Alert tone="info" className="mb-5" title="Real networks need signed partner accounts">MGID, Revcontent, Taboola and Outbrain (Teads) connect once BlissNova has an agency or advertiser account and API access with each. Credentials go in the server environment, never in this page.</Alert>
      <Async res={res}>
        {({ data }) => (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.map((n) => (
              <Card key={n.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-base font-semibold">{n.name}{n.devOnly && <Badge tone="accent">Development only</Badge>}</p>
                    {n.website && <a href={n.website} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted hover:text-primary">{n.website.replace(/^https:\/\//, '')} <ExternalLink className="size-3" /></a>}
                  </div>
                  {n.enabled ? <StatusBadge status="active" label="On" /> : n.available ? <Badge>Off</Badge> : <Badge tone="warning">Not connected</Badge>}
                </div>
                <p className="mt-3 text-sm text-fg-2">{n.connection}</p>
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div><dt className="text-xs text-muted">Markup</dt><dd className="tabular font-medium">{n.markupPercent}%</dd></div>
                  <div><dt className="text-xs text-muted">Partner minimum CPC</dt><dd className="tabular font-medium">{money(n.minCpcMicros)}</dd></div>
                  <div><dt className="text-xs text-muted">Live campaigns</dt><dd className="tabular font-medium">{formatNumber(n.liveCampaigns)} <span className="text-xs font-normal text-muted">of {formatNumber(n.campaigns)}</span></dd></div>
                  <div><dt className="text-xs text-muted">Clicks, 30 days</dt><dd className="tabular font-medium">{formatNumber(n.last30Days.clicks)}</dd></div>
                  <div><dt className="text-xs text-muted">Billed, 30 days</dt><dd className="tabular font-medium">{money(n.last30Days.chargedMicros)}</dd></div>
                  <div><dt className="text-xs text-muted">Margin, 30 days</dt><dd className="tabular font-medium">{money(n.last30Days.marginMicros)}</dd></div>
                </dl>
                {BigInt(n.last30Days.absorbedMicros) > 0n && <p className="mt-2 text-xs text-warning">Absorbed partner cost: {money(n.last30Days.absorbedMicros)}</p>}
                {n.lastCheck && <p className={`mt-3 text-xs ${n.lastCheck.ok ? 'text-success' : 'text-danger'}`}>Connection test {timeAgo(n.lastCheck.at)}: {n.lastCheck.detail}</p>}
                {manage && (
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
                    <Button size="sm" variant={n.enabled ? 'secondary' : 'primary'} disabled={!n.available && !n.enabled} onClick={() => toggle(n)}>{n.enabled ? 'Turn off' : 'Turn on'}</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEdit({ n, markup: String(n.markupPercent), minCpc: microsToInput(n.minCpcMicros), reason: '' })}>Edit pricing</Button>
                    <Button size="sm" variant="ghost" loading={busy === n.id} onClick={() => test(n)}><PlugZap className="size-3.5" /> Test connection</Button>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </Async>

      <div className="mt-6"><SourceReport path="/admin/reports/sources" currency="USD" title="Delivery by source, last 30 days" /></div>

      <div className="mt-8">
        <h2 className="text-base font-semibold">Partner campaigns</h2>
        <p className="mb-3 text-sm text-muted">Every campaign running, or set to run, on a partner network. Open one to hold it on a partner.</p>
        <AdminTable path="/admin/partner-campaigns" rowKey={(r: any) => r.id} statuses={['pending', 'in_review', 'active', 'paused', 'rejected', 'error', 'stopped']} empty="No campaign uses a partner network yet." columns={[
          { key: 'c', header: 'Campaign', cell: (r: any) => <Link className="font-medium text-primary hover:underline" href={`/admin/campaigns/${r.campaignId}`}>{r.campaignName}</Link> },
          { key: 'o', header: 'Advertiser', cell: (r: any) => r.orgName },
          { key: 'n', header: 'Network', cell: (r: any) => r.networkName },
          { key: 's', header: 'Status', cell: (r: any) => <span className="flex items-center gap-1.5"><StatusBadge status={r.status} />{r.adminHold && <Badge tone="warning">Held</Badge>}</span> },
          { key: 'b', header: 'Share', align: 'right', cell: (r: any) => `${r.budgetPercent}%` },
          { key: 'k', header: 'Clicks', align: 'right', cell: (r: any) => formatNumber(r.clicks) },
          { key: 'p', header: 'Billed', align: 'right', cell: (r: any) => money(r.chargedMicros) },
          { key: 'm', header: 'Margin', align: 'right', cell: (r: any) => money(String(BigInt(r.chargedMicros) - BigInt(r.costMicros))) },
          { key: 'y', header: 'Synced', cell: (r: any) => (r.lastSyncedAt ? timeAgo(r.lastSyncedAt) : '—') },
        ]} />
      </div>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit ? `${edit.n.name} pricing` : ''} footer={<Button type="submit" form="pn">Save</Button>}>
        {edit && (
          <form id="pn" className="grid gap-4" onSubmit={async (e) => {
            e.preventDefault();
            try { await patch(`/admin/partners/${edit.n.id}`, { markupPercent: Number(edit.markup), minCpc: edit.minCpc, reason: edit.reason }); setEdit(null); res.reload(); } catch (err) { setError(errorMessage(err)); }
          }}>
            <Field label="Markup (%)" htmlFor="pm" hint="Added on top of what the partner charges. Applies to campaigns that opt in from now on; running ones keep the markup they started with."><Input id="pm" type="number" min={0} max={200} step="0.01" required value={edit.markup} onChange={(e) => setEdit({ ...edit, markup: e.target.value })} /></Field>
            <Field label="Partner minimum CPC (USD)" htmlFor="pc" hint="The lowest bid the partner accepts, before markup."><Input id="pc" required value={edit.minCpc} onChange={(e) => setEdit({ ...edit, minCpc: e.target.value })} /></Field>
            <Field label="Reason" htmlFor="pr" required><Textarea id="pr" rows={2} required minLength={3} value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></Field>
          </form>
        )}
      </Modal>
    </>
  );
}

