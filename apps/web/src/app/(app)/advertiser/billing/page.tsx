'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Download, Plus } from 'lucide-react';
import { Alert, Async, Badge, Button, Card, CardHeader, Field, Input, Modal, PageHeader, Select, Stat, StatusBadge, Table, Tabs, Textarea } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { useOrg, useSession } from '@/lib/session';
import { errorMessage, idempotencyKey, post } from '@/lib/api';
import { formatDate, formatMicros, humanize } from '@/lib/format';

interface Provider { id: string; label: string; supportsCheckout: boolean; detail?: string }

function AddFunds({ orgId, providers, onDone }: { orgId: string; providers: Provider[]; onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [provider, setProvider] = useState(providers[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(idempotencyKey);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ data: { checkout_url: string | null; instructions: string | null } }>(`/orgs/${orgId}/billing/payments`, { amount, provider }, { 'Idempotency-Key': key });
      if (r.data.checkout_url) {
        window.location.href = r.data.checkout_url;
        return;
      }
      setOpen(false);
      onDone(r.data.instructions ?? 'Payment started. Funds appear once the payment is confirmed.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  if (providers.length === 0) return <Badge tone="warning">No payment method is configured yet</Badge>;
  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus className="size-4" /> Add funds</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Add funds" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" form="fund" loading={busy}>Continue</Button></>}>
        <form id="fund" onSubmit={submit} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Amount" htmlFor="amt" required><Input id="amt" inputMode="decimal" required pattern="^\d+(\.\d{1,2})?$" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100.00" /></Field>
          <Field label="Payment method" htmlFor="prov">
            <Select id="prov" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          </Field>
          {provider === 'dev_simulated' && <Alert tone="warning" title="Simulated payment">This local development provider moves no real money. It is refused in production.</Alert>}
          <p className="text-xs text-muted">Your balance is credited only after the payment provider confirms the payment. Returning from a checkout page does not by itself add funds.</p>
        </form>
      </Modal>
    </>
  );
}

function Disputes({ orgId }: { orgId: string }) {
  const res = useApi<{ data: any[] }>(`/orgs/${orgId}/disputes`);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ subjectType: 'payment', body: '' });
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Billing disputes" description="Question a charge, invoice or payment. Finance staff respond here." actions={<Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Open a dispute</Button>} />
      <Async res={res}>
        {({ data }) => <Table rows={data} rowKey={(r) => r.id} empty="No disputes." columns={[
          { key: 'd', header: 'Opened', cell: (r) => formatDate(r.created_at) },
          { key: 's', header: 'About', cell: (r) => humanize(r.subject_type) },
          { key: 'b', header: 'Details', cell: (r) => <span className="line-clamp-2">{r.body}</span> },
          { key: 'st', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'r', header: 'Resolution', cell: (r) => r.resolution ?? '' },
        ]} />}
      </Async>
      <Modal open={open} onClose={() => setOpen(false)} title="Open a dispute" footer={<Button onClick={async () => { try { await post(`/orgs/${orgId}/disputes`, f); setOpen(false); setF({ subjectType: 'payment', body: '' }); res.reload(); } catch (e) { setError(errorMessage(e)); } }}>Submit</Button>}>
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="About" htmlFor="dt"><Select id="dt" value={f.subjectType} onChange={(e) => setF({ ...f, subjectType: e.target.value })}>{['payment', 'invoice', 'campaign', 'other'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</Select></Field>
          <Field label="What happened?" htmlFor="db" hint="At least 10 characters. Include references such as an invoice number."><Textarea id="db" rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        </div>
      </Modal>
    </Card>
  );
}

function Billing() {
  const org = useOrg();
  const { can } = useSession();
  const params = useSearchParams();
  const [tab, setTab] = useState('payments');
  const [notice, setNotice] = useState<string | null>(null);
  const summary = useApi<{ data: any }>(`/orgs/${org.id}/billing`);
  const payments = useApi<{ data: any[] }>(tab === 'payments' ? `/orgs/${org.id}/billing/payments` : null);
  const invoices = useApi<{ data: any[] }>(tab === 'invoices' ? `/orgs/${org.id}/billing/invoices` : null);
  const ledger = useApi<{ data: any[] }>(tab === 'ledger' ? `/orgs/${org.id}/billing/ledger` : null);
  const refunds = useApi<{ data: any[] }>(tab === 'refunds' ? `/orgs/${org.id}/billing/refunds` : null);
  const money = (v: string) => formatMicros(v, org.currency);
  const returned = params.get('status');

  return (
    <>
      <PageHeader title="Billing" description="Prepaid balance. Campaign budgets are reserved when submitted and spend is recorded in a double-entry ledger." actions={can('billing:fund') && summary.data && <AddFunds orgId={org.id} providers={summary.data.data.providers} onDone={(m) => { setNotice(m); summary.reload(); payments.reload(); }} />} />
      {returned === 'returned' && <Alert tone="info" className="mb-4">You returned from checkout. Your balance updates when the payment provider confirms the payment, which can take a moment. Refresh to check.</Alert>}
      {returned === 'cancelled' && <Alert tone="warning" className="mb-4">Checkout was cancelled. No funds were added.</Alert>}
      {notice && <Alert tone="success" className="mb-4">{notice}</Alert>}
      <Async res={summary}>
        {({ data }) => (
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Available balance" value={money(data.availableMicros)} definition="Funds not reserved by any campaign." />
            <Stat label="Reserved for campaigns" value={money(data.reservedMicros)} definition="Budget held for submitted and running campaigns. Unspent reserve returns when a campaign ends or is archived." />
            <Stat label="Payments pending" value={money(data.pendingPaymentsMicros)} />
            <Stat label="Lifetime spend" value={money(data.lifetimeSpendMicros)} />
          </div>
        )}
      </Async>
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'payments', label: 'Payments' }, { id: 'invoices', label: 'Receipts & statements' }, { id: 'ledger', label: 'Ledger' }, { id: 'refunds', label: 'Refunds' }, { id: 'disputes', label: 'Disputes' }]} />
      <div className="mt-5">
        {tab === 'payments' && (
          <Card>
            <Async res={payments}>
              {({ data }) => <Table rows={data} rowKey={(r) => r.id} empty="No payments yet." columns={[
                { key: 'd', header: 'Date', cell: (r) => formatDate(r.created_at, true) },
                { key: 'p', header: 'Method', cell: (r) => <span>{humanize(r.provider)}{r.provider === 'dev_simulated' && <Badge tone="warning" className="ml-2">Simulated</Badge>}</span> },
                { key: 'a', header: 'Amount', align: 'right', cell: (r) => money(r.amount_micros) },
                { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
                { key: 'x', header: '', cell: (r) => r.status === 'pending' && r.checkout_url ? <a className="text-sm text-primary hover:underline" href={r.checkout_url}>Continue checkout</a> : r.failure_reason ?? '' },
              ]} />}
            </Async>
          </Card>
        )}
        {tab === 'invoices' && (
          <Card>
            <Async res={invoices}>
              {({ data }) => <Table rows={data} rowKey={(r) => r.id} empty="No documents yet. A receipt is issued for every confirmed payment." columns={[
                { key: 'n', header: 'Number', cell: (r) => <span className="font-mono text-xs">{r.number}</span> },
                { key: 'k', header: 'Type', cell: (r) => humanize(r.kind) },
                { key: 'd', header: 'Issued', cell: (r) => formatDate(r.issued_at) },
                { key: 't', header: 'Total', align: 'right', cell: (r) => money(r.total_micros) },
                { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
                { key: 'dl', header: '', cell: (r) => <a className="inline-flex items-center gap-1 text-sm text-primary hover:underline" href={`/api/v1/orgs/${org.id}/billing/invoices/${r.id}/download`}><Download className="size-3.5" /> Download</a> },
              ]} />}
            </Async>
          </Card>
        )}
        {tab === 'ledger' && (
          <Card>
            <CardHeader title="Ledger entries" description="Positive amounts are credits to your accounts. Entries are append-only; corrections appear as new entries." />
            <Async res={ledger}>
              {({ data }) => <Table rows={data} rowKey={(r) => `${r.transaction_id}-${r.account}-${r.campaign_id ?? ''}`} empty="No ledger entries yet." columns={[
                { key: 'd', header: 'Date', cell: (r) => formatDate(r.created_at, true) },
                { key: 't', header: 'Type', cell: (r) => humanize(r.type) },
                { key: 'a', header: 'Account', cell: (r) => humanize(r.account) },
                { key: 'r', header: 'Description', cell: (r) => r.reason ?? '' },
                { key: 'm', header: 'Amount', align: 'right', cell: (r) => <span className={Number(r.amount_micros) < 0 ? 'text-danger' : 'text-success'}>{money(r.amount_micros)}</span> },
              ]} />}
            </Async>
          </Card>
        )}
        {tab === 'refunds' && (
          <Card>
            <Async res={refunds}>
              {({ data }) => <Table rows={data} rowKey={(r) => r.id} empty="No refunds." columns={[
                { key: 'd', header: 'Date', cell: (r) => formatDate(r.created_at) },
                { key: 'a', header: 'Amount', align: 'right', cell: (r) => money(r.amount_micros) },
                { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
                { key: 'r', header: 'Reason', cell: (r) => r.reason ?? '' },
              ]} />}
            </Async>
          </Card>
        )}
        {tab === 'disputes' && <Disputes orgId={org.id} />}
      </div>
    </>
  );
}

export default function Page() {
  return <Suspense><Billing /></Suspense>;
}
