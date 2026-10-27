'use client';
import { useState, type FormEvent } from 'react';
import { Download } from 'lucide-react';
import { Alert, Async, Badge, Button, Card, CardHeader, Field, Input, PageHeader, Select, StatusBadge, Table, Tabs, Textarea } from '@/components/ui';
import { AdminTable, ReasonAction, SimpleTable } from '@/components/admin/kit';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { errorMessage, patch, post, qs } from '@/lib/api';
import { formatDate, formatMicros, humanize, isoDay, timeAgo } from '@/lib/format';

function Summary() {
  const res = useApi<{ data: any }>('/admin/finance/summary');
  const recon = useApi<{ data: { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }>; ranAt: string } }>('/admin/finance/reconciliation');
  const { canAdmin } = useSession();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Reconciliation" description="Checks that the ledger balances and matches campaign spend and reserves." actions={<Button size="sm" variant="secondary" onClick={recon.reload}>Run again</Button>} />
        <Async res={recon}>{({ data }) => (
          <ul className="space-y-2 text-sm">{data.checks.map((c) => <li key={c.name} className="flex items-center gap-2"><Badge tone={c.ok ? 'success' : 'danger'}>{c.ok ? 'OK' : 'Mismatch'}</Badge>{c.name}{!c.ok && <span className="text-muted">({c.detail})</span>}</li>)}</ul>
        )}</Async>
      </Card>
      <Async res={res}>{({ data }) => (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card><CardHeader title="Ledger balances" /><SimpleTable rows={data.balances} rowKey={(r: any) => r.kind + r.currency} columns={[{ key: 'k', header: 'Account', cell: (r: any) => humanize(r.kind) }, { key: 'b', header: 'Balance', align: 'right', cell: (r: any) => formatMicros(r.balance, r.currency) }]} /></Card>
          <Card>
            <CardHeader title="Settlement" description="Groups unsettled billable events, credits publisher pending balances and releases matured holds. The worker also runs this on a schedule." actions={canAdmin('admin:finance:manage') && <Button size="sm" onClick={async () => { try { const r = await post<{ data: { settlements: unknown[]; finalized: number } }>('/admin/finance/settle'); setMsg(`Created ${r.data.settlements.length} settlement(s), released ${r.data.finalized}.`); res.reload(); } catch (e) { setMsg(errorMessage(e)); } }}>Run settlement</Button>} />
            {msg && <Alert tone="info" className="mb-3">{msg}</Alert>}
            <SimpleTable rows={data.unsettled} rowKey={(r: any) => r.currency} empty="No unsettled billable events." columns={[{ key: 'c', header: 'Currency', cell: (r: any) => r.currency }, { key: 'n', header: 'Events', align: 'right', cell: (r: any) => r.n }, { key: 't', header: 'Charges', align: 'right', cell: (r: any) => formatMicros(r.total, r.currency) }]} />
          </Card>
          <Card><CardHeader title="Payments by status" /><SimpleTable rows={data.payments} rowKey={(r: any) => r.status + r.currency} columns={[{ key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> }, { key: 'n', header: 'Count', align: 'right', cell: (r: any) => r.n }, { key: 't', header: 'Total', align: 'right', cell: (r: any) => formatMicros(r.total, r.currency) }]} /></Card>
          <Card><CardHeader title="Payouts by status" /><SimpleTable rows={data.payouts} rowKey={(r: any) => r.status + r.currency} columns={[{ key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> }, { key: 'n', header: 'Count', align: 'right', cell: (r: any) => r.n }, { key: 't', header: 'Total', align: 'right', cell: (r: any) => formatMicros(r.total, r.currency) }]} /></Card>
        </div>
      )}</Async>
    </div>
  );
}

function Payments() {
  const { canAdmin } = useSession();
  const [k, setK] = useState(0);
  const manage = canAdmin('admin:finance:manage');
  return (
    <AdminTable<any> path="/admin/finance/payments" reloadKey={k} statuses={['pending', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'cancelled']} rowKey={(r) => r.id} columns={[
      { key: 'd', header: 'Created', cell: (r) => formatDate(r.created_at, true) },
      { key: 'o', header: 'Organization', cell: (r) => r.org_name },
      { key: 'p', header: 'Provider', cell: (r) => <span>{humanize(r.provider)}{r.provider === 'dev_simulated' && <Badge tone="warning" className="ml-1">Simulated</Badge>}</span> },
      { key: 'r', header: 'Reference', cell: (r) => <code className="text-xs">{r.provider_ref ?? '—'}</code> },
      { key: 'a', header: 'Amount', align: 'right', cell: (r) => formatMicros(r.amount_micros, r.currency) },
      { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
      { key: 'x', header: '', cell: (r) => manage && (
        <span className="flex gap-1">
          {r.status === 'pending' && r.provider === 'manual' && <ReasonAction label="Confirm received" title="Confirm bank transfer received" path="" onDone={() => setK((x) => x + 1)} description="Only confirm after the funds are visible in the bank account. Enter the bank reference in the next step." run={async (reason) => { const ref = window.prompt('Bank or provider reference for this transfer'); if (!ref) throw new Error('A reference is required'); await post(`/admin/finance/payments/${r.id}/confirm`, { reason, providerRef: ref }); }} />}
          {r.status === 'pending' && <ReasonAction label="Mark failed" title="Mark payment failed" path={`/admin/finance/payments/${r.id}/fail`} onDone={() => setK((x) => x + 1)} />}
          {['succeeded', 'partially_refunded'].includes(r.status) && <ReasonAction label="Record refund" title="Record a refund" path="" onDone={() => setK((x) => x + 1)} description="Record a refund already issued through the provider or bank. It debits the advertiser balance." run={async (reason) => { const amount = window.prompt('Refund amount (for example 25.00)'); if (!amount) throw new Error('An amount is required'); await post(`/admin/finance/payments/${r.id}/refund`, { amount, reason }); }} />}
        </span>
      ) },
    ]} />
  );
}

function Ledger() {
  const [txnType, setTxnType] = useState('');
  return (
    <AdminTable<any> path="/admin/finance/ledger" search={false} extra={{ txnType: txnType || undefined }} rowKey={(r) => r.id}
      toolbar={<Select aria-label="Type" value={txnType} onChange={(e) => setTxnType(e.target.value)} className="max-w-[220px]"><option value="">All transaction types</option>{['payment', 'campaign_reserve', 'campaign_release', 'ad_charge', 'charge_reversal', 'earnings_finalize', 'payout_approve', 'payout_paid', 'payout_failed', 'refund', 'adjustment'].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select>}
      columns={[
        { key: 'd', header: 'When', cell: (r) => formatDate(r.created_at, true) },
        { key: 't', header: 'Type', cell: (r) => <Badge>{humanize(r.type)}</Badge> },
        { key: 'r', header: 'Reason', cell: (r) => <span className="text-sm">{r.reason}{r.actor_name ? <span className="text-muted"> · {r.actor_name}</span> : ''}</span> },
        { key: 'e', header: 'Entries', cell: (r) => <ul className="text-xs">{r.entries.map((e: any, i: number) => <li key={i} className="tabular">{humanize(e.kind)}{e.org_name ? ` (${e.org_name})` : ''}: {formatMicros(e.amount_micros)}</li>)}</ul> },
      ]} />
  );
}

function Adjustment() {
  const [f, setF] = useState({ orgId: '', account: 'advertiser_wallet', amount: '', reason: '' });
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await post('/admin/finance/adjustments', f);
      setMsg({ tone: 'success', text: 'Adjustment recorded as a new ledger transaction.' });
      setF({ ...f, amount: '', reason: '' });
    } catch (err) {
      setMsg({ tone: 'danger', text: errorMessage(err) });
    }
  }
  return (
    <Card>
      <CardHeader title="Manual adjustment" description="Corrections are new balanced ledger entries against an adjustment account. Existing entries are never edited or deleted." />
      <form onSubmit={submit} className="grid max-w-2xl gap-4 sm:grid-cols-2">
        {msg && <Alert tone={msg.tone} className="sm:col-span-2">{msg.text}</Alert>}
        <Field label="Organization ID" htmlFor="ao" required><Input id="ao" required value={f.orgId} onChange={(e) => setF({ ...f, orgId: e.target.value })} placeholder="UUID from the organization page" /></Field>
        <Field label="Account" htmlFor="aa"><Select id="aa" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}><option value="advertiser_wallet">Advertiser balance</option><option value="publisher_available">Publisher available earnings</option></Select></Field>
        <Field label="Amount" htmlFor="am" required hint="Negative to debit, for example -10.00"><Input id="am" required pattern="^-?\d{1,12}(\.\d{1,6})?$" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Reason" htmlFor="ar" required className="sm:col-span-2" hint="At least 10 characters. Recorded in the ledger and audit log."><Textarea id="ar" required minLength={10} rows={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        <div><Button type="submit">Record adjustment</Button></div>
      </form>
    </Card>
  );
}

function Providers() {
  const res = useApi<{ data: any[] }>('/admin/finance/providers');
  const { canAdmin } = useSession();
  return (
    <Card>
      <CardHeader title="Payment providers" description="Credentials are set through environment variables on the server, never in this interface." />
      <Async res={res}>{({ data }) => <Table rows={data} rowKey={(r) => r.id} columns={[
        { key: 'l', header: 'Provider', cell: (r) => <div><p className="font-medium">{r.label}</p><p className="text-xs text-muted">{r.detail}</p></div> },
        { key: 'c', header: 'Configured', cell: (r) => (r.configured ? <Badge tone="success">Yes</Badge> : <Badge>No</Badge>) },
        { key: 'k', header: 'Last connection test', cell: (r) => (r.lastCheck ? <span><Badge tone={r.lastCheck.ok ? 'success' : 'danger'}>{r.lastCheck.ok ? 'Passed' : 'Failed'}</Badge> <span className="text-xs text-muted">{timeAgo(r.lastCheck.created_at)}</span></span> : 'Never tested') },
        { key: 'w', header: 'Webhook URL', cell: (r) => (r.webhookUrl ? <code className="break-all text-xs">{r.webhookUrl}</code> : '—') },
        { key: 'x', header: '', cell: (r) => canAdmin('admin:finance:manage') && r.configured && <Button size="sm" variant="secondary" onClick={async () => { await post(`/admin/finance/providers/${r.id}/test`).catch(() => undefined); res.reload(); }}>Test</Button> },
      ]} />}</Async>
    </Card>
  );
}

function Exports() {
  const [range, setRange] = useState({ from: isoDay(new Date(Date.now() - 29 * 86_400_000)), to: isoDay(new Date()) });
  return (
    <Card>
      <CardHeader title="Exports" description="CSV files for accounting." />
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From" htmlFor="ef"><Input id="ef" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To" htmlFor="et"><Input id="et" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
        {(['ledger', 'payments', 'payouts'] as const).map((k) => <a key={k} href={`/api/v1/admin/finance/export${qs({ kind: k, ...range })}`} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-surface-2"><Download className="size-4" /> {humanize(k)}</a>)}
      </div>
    </Card>
  );
}

export default function Finance() {
  const [tab, setTab] = useState('summary');
  const { canAdmin } = useSession();
  return (
    <>
      <PageHeader title="Finance" description="Double-entry ledger, payments, invoices and reconciliation. Balances change only through balanced ledger transactions." />
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'summary', label: 'Summary' }, { id: 'payments', label: 'Payments' }, { id: 'ledger', label: 'Ledger' }, { id: 'invoices', label: 'Invoices' }, { id: 'webhooks', label: 'Webhooks' }, { id: 'disputes', label: 'Disputes' }, { id: 'providers', label: 'Providers' }, ...(canAdmin('admin:finance:manage') ? [{ id: 'adjust', label: 'Adjustments' }] : []), { id: 'export', label: 'Export' }]} />
      <div className="mt-5">
        {tab === 'summary' && <Summary />}
        {tab === 'payments' && <Payments />}
        {tab === 'ledger' && <Ledger />}
        {tab === 'invoices' && <AdminTable<any> path="/admin/finance/invoices" search={false} rowKey={(r) => r.id} columns={[
          { key: 'n', header: 'Number', cell: (r) => <code className="text-xs">{r.number}</code> }, { key: 'o', header: 'Organization', cell: (r) => r.org_name }, { key: 'k', header: 'Type', cell: (r) => humanize(r.kind) },
          { key: 't', header: 'Total', align: 'right', cell: (r) => formatMicros(r.total_micros, r.currency) }, { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> }, { key: 'd', header: 'Issued', cell: (r) => formatDate(r.issued_at) },
        ]} />}
        {tab === 'webhooks' && <AdminTable<any> path="/admin/finance/webhooks" search={false} rowKey={(r) => r.id} columns={[
          { key: 'd', header: 'Received', cell: (r) => formatDate(r.received_at, true) }, { key: 'p', header: 'Provider', cell: (r) => r.provider }, { key: 't', header: 'Type', cell: (r) => r.type },
          { key: 's', header: 'Signature', cell: (r) => (r.signature_valid ? <Badge tone="success">Valid</Badge> : <Badge tone="danger">Invalid</Badge>) },
          { key: 'x', header: 'Processed', cell: (r) => (r.processing_error ? <span className="text-danger text-xs">{r.processing_error}</span> : r.processed_at ? 'Yes' : 'No') },
        ]} />}
        {tab === 'disputes' && <Disputes />}
        {tab === 'providers' && <Providers />}
        {tab === 'adjust' && <Adjustment />}
        {tab === 'export' && <Exports />}
      </div>
    </>
  );
}

function Disputes() {
  const [k, setK] = useState(0);
  return (
    <AdminTable<any> path="/admin/disputes" reloadKey={k} statuses={['open', 'under_review', 'resolved', 'rejected']} search={false} rowKey={(r) => r.id} columns={[
      { key: 'd', header: 'Opened', cell: (r) => formatDate(r.created_at) }, { key: 'o', header: 'Organization', cell: (r) => r.org_name }, { key: 's', header: 'About', cell: (r) => humanize(r.subject_type) },
      { key: 'b', header: 'Details', cell: (r) => <span className="line-clamp-3 text-sm">{r.body}</span> }, { key: 'st', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
      { key: 'x', header: '', cell: (r) => !['resolved', 'rejected'].includes(r.status) && (
        <span className="flex gap-1">
          <ReasonAction label="Resolve" title="Resolve dispute" path="" onDone={() => setK((x) => x + 1)} description="The resolution is shown to the customer. Record any money movement separately as an adjustment or refund." run={(resolution) => patch(`/admin/disputes/${r.id}`, { status: 'resolved', resolution })} />
          <ReasonAction label="Reject" title="Reject dispute" path="" onDone={() => setK((x) => x + 1)} run={(resolution) => patch(`/admin/disputes/${r.id}`, { status: 'rejected', resolution })} />
        </span>
      ) },
    ]} />
  );
}
