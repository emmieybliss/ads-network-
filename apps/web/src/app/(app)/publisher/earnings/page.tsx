'use client';
import { useState, type FormEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { Alert, Async, Badge, Button, Card, CardHeader, Field, Input, PageHeader, Stat, StatusBadge, Table } from '@/components/ui';
import { PayoutMethodCard } from '@/components/publisher/PayoutMethod';
import { useApi } from '@/lib/hooks';
import { useOrg, useSession } from '@/lib/session';
import { errorMessage, idempotencyKey, post } from '@/lib/api';
import { formatDate, formatMicros, formatNumber, microsToInput } from '@/lib/format';

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
              <PayoutMethodCard orgId={org.id} allowed={data.payoutMethods ?? ['paypal', 'bank_transfer', 'crypto']} autoPayoutDay={data.autoPayoutDay ?? 0} canEdit={can('payout:request')} />
              <Card>
                <CardHeader title="Request a payout" description={<>Minimum payout {money(data.minimumPayoutMicros)}. {data.autoPayoutDay ? `Or turn on monthly payouts and we request it for you on day ${data.autoPayoutDay}.` : ''}</>} />
                {org.status !== 'approved' ? <p className="text-sm text-muted">Payouts are available once your publisher account is approved.</p> : !can('payout:request') ? <p className="text-sm text-muted">Your role cannot request payouts.</p> : (
                  <form onSubmit={request} className="flex flex-wrap items-end gap-3">
                    <Field label="Amount" htmlFor="pa"><Input id="pa" inputMode="decimal" required pattern="^\d+(\.\d{1,2})?$" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></Field>
                    {BigInt(data.availableMicros) >= 10_000n && <Button type="button" variant="ghost" onClick={() => setAmount(microsToInput(((BigInt(data.availableMicros) / 10_000n) * 10_000n).toString()))}>Use full balance</Button>}
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
                  { key: 'm', header: 'Method', cell: (r) => <span>{r.method_label ?? ''}{r.auto_requested && <Badge tone="info" className="ml-2">Monthly</Badge>}</span> },
                  { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
                  { key: 'p', header: 'Paid', cell: (r) => (r.paid_at ? formatDate(r.paid_at) : r.sent_at ? `Sent ${formatDate(r.sent_at)}` : '') },
                  { key: 'ref', header: 'Reference', cell: (r) => r.status !== 'paid' || !r.provider_ref ? '' : r.explorer_url
                    ? <a href={r.explorer_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline">{String(r.provider_ref).slice(0, 10)}… <ExternalLink className="size-3" /></a>
                    : <span className="font-mono text-xs">{r.provider_ref}</span> },
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
