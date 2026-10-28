'use client';
import { useState, type FormEvent } from 'react';
import { AlertTriangle, Download, Eye, Send } from 'lucide-react';
import { PAYOUT_STATUSES } from '@blissnova/shared';
import { Alert, Async, Badge, Button, Card, CardHeader, Field, Input, Modal, PageHeader, StatusBadge, Textarea } from '@/components/ui';
import { AdminTable, ReasonAction } from '@/components/admin/kit';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { errorMessage, get, post } from '@/lib/api';
import { formatDate, formatMicros, humanize } from '@/lib/format';

interface SendOption { id: string; label: string; mode: string }
interface ProviderStatus { id: string; label: string; configured: boolean; methods: string[]; mode: string; detail: string; webhookUrl: string | null }

const DEST_LABELS: Record<string, string> = { email: 'PayPal email', accountHolder: 'Account holder', bankName: 'Bank', country: 'Country', iban: 'IBAN', accountNumber: 'Account number', routingNumber: 'Routing / sort / bank code', swift: 'SWIFT/BIC', asset: 'Asset', networkLabel: 'Network', address: 'Wallet address', memo: 'Memo / tag' };

/** Shows the full destination (step-up + audited) and records a payment staff made by hand. */
function ManualPay({ payout, onClose, onDone }: { payout: any; onClose: () => void; onDone: () => void }) {
  const [dest, setDest] = useState<Record<string, string> | null>(null);
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const crypto = payout.method === 'crypto';
  async function reveal() {
    setError(null);
    try {
      setDest((await get<{ data: Record<string, string> | null }>(`/admin/payouts/${payout.id}/destination`)).data ?? {});
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (payout.status === 'approved') await post(`/admin/payouts/${payout.id}/processing`, { provider: 'manual' });
      await post(`/admin/payouts/${payout.id}/paid`, { providerRef: ref.trim(), reason });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Pay ${payout.org_name} manually`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="manual-pay" loading={busy}>Record as paid</Button></>}>
      <form id="manual-pay" onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <p className="text-sm">Send <strong>{formatMicros(payout.amount_micros, payout.currency)}</strong> by {humanize(payout.method ?? 'other')}, then record the reference here. The publisher&apos;s balance moves only when you record it.</p>
        {dest ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl bg-surface-2 p-3 text-sm">
            {Object.entries(dest).filter(([k, v]) => v && k !== 'method' && k !== 'network').map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{DEST_LABELS[k] ?? humanize(k)}</dt><dd className="break-all font-mono text-xs leading-5">{v}</dd></div>)}
            {Object.keys(dest).length === 0 && <dd className="col-span-2 text-muted">No stored details (older payout). Use the label: {payout.method_label}</dd>}
          </dl>
        ) : payout.has_destination ? <Button type="button" variant="secondary" size="sm" onClick={reveal}><Eye className="size-4" /> Show full payout details</Button> : <p className="text-sm text-muted">Destination: {payout.method_label}</p>}
        {payout.details_recently_changed && <Alert tone="warning">The publisher changed their payout details shortly before this request. Confirm the change with them before paying.</Alert>}
        <Field label={crypto ? 'Transaction hash' : 'Bank or transfer reference'} htmlFor="mp-ref" required hint={crypto ? 'Checked against the network format, then shown to the publisher with a block explorer link.' : 'The reference from your bank or payment app.'}>
          <Input id="mp-ref" required minLength={3} maxLength={120} className="font-mono text-xs" value={ref} onChange={(e) => setRef(e.target.value)} />
        </Field>
        <Field label="Note" htmlFor="mp-reason" required><Textarea id="mp-reason" rows={2} required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Paid from operating account" /></Field>
      </form>
    </Modal>
  );
}

function SendButtons({ payout, onDone, onError }: { payout: any; onDone: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (payout.send_options as SendOption[]).map((o) => (
    <Button key={o.id} size="sm" variant={o.mode === 'simulated' ? 'secondary' : 'primary'} loading={busy === o.id}
      onClick={async () => {
        if (o.mode !== 'simulated' && !window.confirm(`Send ${formatMicros(payout.amount_micros, payout.currency)} to ${payout.method_label} with ${o.label}? Money leaves your ${o.label} balance.`)) return;
        setBusy(o.id);
        try {
          await post(`/admin/payouts/${payout.id}/send`, { provider: o.id });
          onDone();
        } catch (e) {
          onError(errorMessage(e));
        } finally {
          setBusy(null);
        }
      }}>
      <Send className="size-3.5" /> {o.mode === 'simulated' ? 'Send (simulated)' : `Send with ${o.label.replace(/ Payouts$/, '')}`}
    </Button>
  ));
}

async function download(method: 'bank_transfer' | 'crypto') {
  const csv = await get<string>(`/admin/payouts/export?method=${method}`);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `approved-${method}-payouts.csv` });
  a.click();
  URL.revokeObjectURL(url);
}

export default function Payouts() {
  const { canAdmin } = useSession();
  const [k, setK] = useState(0);
  const [manual, setManual] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providers = useApi<{ data: { providers: ProviderStatus[]; manual: string[] } }>('/admin/finance/payout-providers');
  const manage = canAdmin('admin:payouts:manage');
  const done = () => { setError(null); setK((x) => x + 1); };
  return (
    <>
      <PageHeader title="Payouts" description="Requested → approved → sent → paid. PayPal payouts are sent and confirmed automatically; bank and crypto payouts are paid by finance and recorded with their reference."
        actions={manage && <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => download('bank_transfer').catch((e) => setError(errorMessage(e)))}><Download className="size-4" /> Approved bank payouts (CSV)</Button>
          <Button size="sm" variant="secondary" onClick={() => download('crypto').catch((e) => setError(errorMessage(e)))}><Download className="size-4" /> Approved crypto payouts (CSV)</Button>
        </div>} />
      <Card className="mb-5">
        <CardHeader title="Payout providers" description="Credentials are set in the server environment. Without a provider, payouts are paid by hand and recorded here." />
        <Async res={providers}>
          {({ data }) => (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.providers.map((p) => (
                <div key={p.id} className="rounded-xl border border-border p-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-medium">{p.label}
                    <Badge tone={!p.configured ? 'neutral' : p.mode === 'live' ? 'success' : 'warning'}>{!p.configured ? 'Not connected' : p.mode === 'live' ? 'Live' : p.mode === 'simulated' ? 'Simulated' : 'Sandbox'}</Badge></p>
                  <p className="mt-1 text-xs text-muted">{p.detail}</p>
                  {p.webhookUrl && <p className="mt-1 break-all font-mono text-[11px] text-muted">Webhook: {p.webhookUrl}</p>}
                </div>
              ))}
              <div className="rounded-xl border border-border p-3 text-sm">
                <p className="flex items-center gap-2 font-medium">Bank transfer and crypto <Badge tone="info">Manual</Badge></p>
                <p className="mt-1 text-xs text-muted">Export approved payouts as CSV for a bulk bank upload or wallet batch, then record each reference. Crypto references are checked as transaction hashes.</p>
              </div>
            </div>
          )}
        </Async>
      </Card>
      {error && <Alert tone="danger" className="mb-4">{error}</Alert>}
      <AdminTable<any> path="/admin/payouts" reloadKey={k} statuses={[...PAYOUT_STATUSES]} search={false} rowKey={(r) => r.id} columns={[
        { key: 'd', header: 'Requested', cell: (r) => formatDate(r.created_at) },
        { key: 'o', header: 'Publisher', cell: (r) => <div><p>{r.org_name}</p><p className="text-xs text-muted">{r.auto_requested ? 'Monthly automatic request' : `by ${r.requested_by_name}`}</p>{r.details_recently_changed && ['requested', 'approved'].includes(r.status) && <Badge tone="warning" className="mt-1"><AlertTriangle className="mr-1 inline size-3" />Details changed recently</Badge>}</div> },
        { key: 'a', header: 'Amount', align: 'right', cell: (r) => formatMicros(r.amount_micros, r.currency) },
        { key: 'm', header: 'Method', cell: (r) => <div><p>{r.method_label ?? '—'}</p>{r.provider && <p className="text-xs text-muted">via {humanize(r.provider)}</p>}</div> },
        { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
        { key: 'r', header: 'Reference / notes', cell: (r) => <span className="break-all text-xs">{r.provider_ref ? <span className="font-mono">{r.provider_ref}</span> : null} {r.failure_reason ?? r.review_reason ?? ''}</span> },
        { key: 'x', header: '', cell: (r) => manage && (
          <span className="flex flex-wrap gap-1">
            {r.status === 'requested' && <ReasonAction label="Approve" title="Approve payout" path={`/admin/payouts/${r.id}/approve`} variant="primary" onDone={done} description="Moves the amount out of the publisher's available balance and reserves it for this payout." />}
            {r.status === 'requested' && <ReasonAction label="Reject" title="Reject payout" path={`/admin/payouts/${r.id}/reject`} danger onDone={done} description="Funds return to the publisher's available balance." />}
            {r.status === 'approved' && <SendButtons payout={r} onDone={done} onError={setError} />}
            {r.status === 'approved' && <Button size="sm" variant="secondary" onClick={() => setManual(r)}>Pay manually</Button>}
            {r.status === 'processing' && r.provider === 'dev_simulated' && <>
              <Button size="sm" variant="secondary" onClick={() => post(`/admin/payouts/${r.id}/simulate`, { outcome: 'paid' }).then(done, (e) => setError(errorMessage(e)))}>Simulate paid</Button>
              <Button size="sm" variant="ghost" onClick={() => post(`/admin/payouts/${r.id}/simulate`, { outcome: 'failed' }).then(done, (e) => setError(errorMessage(e)))}>Simulate failure</Button>
            </>}
            {r.status === 'processing' && r.provider === 'paypal' && <span className="text-xs text-muted">Waiting for PayPal</span>}
            {r.status === 'processing' && r.provider === 'manual' && <Button size="sm" variant="secondary" onClick={() => setManual(r)}>Mark paid</Button>}
            {r.status === 'processing' && r.provider !== 'dev_simulated' && <ReasonAction label="Mark failed" title="Record payout failure" path={`/admin/payouts/${r.id}/failed`} danger onDone={done} description="Funds return to the publisher's available balance." />}
          </span>
        ) },
      ]} />
      {manual && <ManualPay payout={manual} onClose={() => setManual(null)} onDone={() => { setManual(null); done(); }} />}
    </>
  );
}
