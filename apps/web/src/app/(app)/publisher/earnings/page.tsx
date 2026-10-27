'use client';
import { useState, type FormEvent } from 'react';
import { Alert, Async, Badge, Button, Card, CardHeader, Field, Input, Modal, PageHeader, Select, Stat, StatusBadge, Table } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { useOrg, useSession } from '@/lib/session';
import { errorMessage, idempotencyKey, post, put } from '@/lib/api';
import { formatDate, formatMicros, formatNumber, humanize } from '@/lib/format';

function PayoutProfile({ orgId }: { orgId: string }) {
  const res = useApi<{ data: { method: string; display_label: string; updated_at: string } | null }>(`/orgs/${orgId}/payout-profile`);
  const [edit, setEdit] = useState<{ method: string; displayLabel: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Payout method" description="We store only a label you choose. Never enter full bank or card numbers here; finance staff collect payment details through a secure channel." actions={<Button size="sm" variant="secondary" onClick={() => setEdit({ method: res.data?.data?.method ?? 'bank_transfer', displayLabel: res.data?.data?.display_label ?? '' })}>{res.data?.data ? 'Change' : 'Set up'}</Button>} />
      <Async res={res}>{({ data }) => data ? <p className="text-sm">{humanize(data.method)} · {data.display_label} <span className="text-muted">(updated {formatDate(data.updated_at)})</span></p> : <p className="text-sm text-muted">No payout method yet.</p>}</Async>
      <Modal open={!!edit} onClose={() => setEdit(null)} title="Payout method" footer={<Button onClick={async () => { try { await put(`/orgs/${orgId}/payout-profile`, edit); setEdit(null); res.reload(); } catch (e) { setError(errorMessage(e)); } }}>Save</Button>}>
        {edit && (
          <div className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Method" htmlFor="pm"><Select id="pm" value={edit.method} onChange={(e) => setEdit({ ...edit, method: e.target.value })}><option value="bank_transfer">Bank transfer</option><option value="paypal">PayPal</option><option value="other">Other</option></Select></Field>
            <Field label="Label" htmlFor="pl" hint="For example “Business account ending 1234”."><Input id="pl" minLength={3} maxLength={120} value={edit.displayLabel} onChange={(e) => setEdit({ ...edit, displayLabel: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
    </Card>
  );
}

export default function Earnings() {
  const org = useOrg();
  const { can } = useSession();
  const res = useApi<{ data: any }>(`/orgs/${org.id}/earnings`);
  const payouts = useApi<{ data: any[] }>(`/orgs/${org.id}/payouts`);
  const [amount, setAmount] = useState('');
  const [key, setKey] = useState(idempotencyKey);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const money = (v: string) => formatMicros(v, org.currency);

  async function request(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await post(`/orgs/${org.id}/payouts`, { amount }, { 'Idempotency-Key': key });
      setMsg({ tone: 'success', text: 'Payout requested. Finance reviews every request before paying.' });
      setAmount('');
      setKey(idempotencyKey());
      res.reload();
      payouts.reload();
    } catch (err) {
      setMsg({ tone: 'danger', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Earnings & payouts" description="Earnings move from estimated, to pending during the hold period, to available. Only available earnings can be paid out." />
      <Async res={res}>
        {({ data }) => (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <Stat label="Estimated, not yet settled" value={money(data.estimatedUnsettledMicros)} definition="Your share of valid events since the last settlement." />
              <Stat label="Pending (in hold)" value={money(data.pendingMicros)} definition={`Settled earnings held for ${data.holdDays} days so invalid traffic can be reversed.`} />
              <Stat label="Available" value={money(data.availableMicros)} />
              <Stat label="Payout in progress" value={money(data.processingMicros)} />
              <Stat label="Paid to date" value={money(data.paidMicros)} />
            </div>
            {data.premium?.tier === 'premium' && (
              <Card>
                <CardHeader title={<span className="flex items-center gap-2">Premium publisher <Badge tone="info">Premium</Badge></span>}
                  description={data.premium.earningsMode === 'floor'
                    ? 'Only ads that pay at least your minimum, after revenue share, are shown on your sites. This can mean fewer ads fill your placements.'
                    : data.premium.earningsMode === 'guarantee'
                      ? 'If your valid earnings for a day fall below your minimum, the network tops them up from its own funds, up to a monthly cap. Top-ups follow the same hold period as other earnings.'
                      : 'Your account has premium status.'} />
                <dl className="grid grid-cols-2 gap-3 text-sm lg:grid-cols-4">
                  {data.premium.minCpmMicros && <div><dt className="text-muted">Minimum per 1,000 impressions</dt><dd className="font-medium">{money(data.premium.minCpmMicros)}</dd></div>}
                  {data.premium.minCpcMicros && <div><dt className="text-muted">Minimum per click</dt><dd className="font-medium">{money(data.premium.minCpcMicros)}</dd></div>}
                  {data.premium.earningsMode === 'guarantee' && <div><dt className="text-muted">Monthly top-up cap</dt><dd className="font-medium">{money(data.premium.guaranteeMonthlyCapMicros)}</dd></div>}
                  {data.premium.premiumAdvertisersOnly && <div><dt className="text-muted">Advertisers</dt><dd className="font-medium">Premium only</dd></div>}
                </dl>
                {data.premium.earningsMode === 'guarantee' && (
                  <div className="mt-4">
                    <Table rows={data.guarantees ?? []} rowKey={(r: any) => r.day} empty="No guarantee days calculated yet. They are calculated each night for the previous day." columns={[
                      { key: 'd', header: 'Day', cell: (r: any) => formatDate(r.day) },
                      { key: 'i', header: 'Valid impressions', align: 'right', cell: (r: any) => formatNumber(r.impressions) },
                      { key: 'c', header: 'Valid clicks', align: 'right', cell: (r: any) => formatNumber(r.clicks) },
                      { key: 'e', header: 'Earned', align: 'right', cell: (r: any) => money(r.earnedMicros) },
                      { key: 'q', header: 'Minimum', align: 'right', cell: (r: any) => money(r.requiredMicros) },
                      { key: 't', header: 'Top-up', align: 'right', cell: (r: any) => <>{money(r.topupMicros)}{r.capped && <Badge tone="warning" className="ml-1">Cap reached</Badge>}</> },
                    ]} />
                  </div>
                )}
              </Card>
            )}
            <div className="grid gap-5 lg:grid-cols-2">
              <PayoutProfile orgId={org.id} />
              <Card>
                <CardHeader title="Request a payout" description={`Minimum payout ${money(data.minimumPayoutMicros)}.`} />
                {org.status !== 'approved' ? <p className="text-sm text-muted">Payouts are available once your publisher account is approved.</p> : !can('payout:request') ? <p className="text-sm text-muted">Your role cannot request payouts.</p> : (
                  <form onSubmit={request} className="flex flex-wrap items-end gap-3">
                    <Field label="Amount" htmlFor="pa"><Input id="pa" inputMode="decimal" required pattern="^\d+(\.\d{1,2})?$" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></Field>
                    <Button type="submit" loading={busy}>Request payout</Button>
                  </form>
                )}
                {msg && <Alert tone={msg.tone} className="mt-3">{msg.text}</Alert>}
              </Card>
            </div>
            <Card>
              <CardHeader title="Payout requests" />
              <Async res={payouts}>
                {({ data: rows }) => <Table rows={rows} rowKey={(r) => r.id} empty="No payouts yet." columns={[
                  { key: 'd', header: 'Requested', cell: (r) => formatDate(r.created_at) },
                  { key: 'a', header: 'Amount', align: 'right', cell: (r) => money(r.amount_micros) },
                  { key: 'm', header: 'Method', cell: (r) => r.method_label ?? '' },
                  { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
                  { key: 'n', header: 'Notes', cell: (r) => r.failure_reason ?? r.review_reason ?? '' },
                  { key: 'x', header: '', cell: (r) => r.status === 'requested' && <Button size="sm" variant="ghost" onClick={async () => { try { await post(`/orgs/${org.id}/payouts/${r.id}/cancel`); payouts.reload(); res.reload(); } catch (e) { setMsg({ tone: 'danger', text: errorMessage(e) }); } }}>Cancel</Button> },
                ]} />}
              </Async>
            </Card>
            <Card>
              <CardHeader title="Settlements" description="Each settlement groups valid events. Reversals for invalid traffic found later are shown separately." />
              <Table rows={data.settlements} rowKey={(r: any) => r.id} empty="No settlements yet." columns={[
                { key: 'd', header: 'Settled', cell: (r: any) => formatDate(r.createdAt) },
                { key: 'e', header: 'Events', align: 'right', cell: (r: any) => r.events },
                { key: 'm', header: 'Earnings', align: 'right', cell: (r: any) => money(r.earningsMicros) },
                { key: 'r', header: 'Reversed', align: 'right', cell: (r: any) => money(r.reversedMicros) },
                { key: 'h', header: 'Hold until', cell: (r: any) => formatDate(r.holdUntil) },
                { key: 'f', header: 'Released', cell: (r: any) => (r.finalizedAt ? formatDate(r.finalizedAt) : 'In hold') },
              ]} />
            </Card>
          </div>
        )}
      </Async>
    </>
  );
}
