'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Async, Badge, Button, Card, CardHeader, Field, Input, Modal, PageHeader, Select, Stat, StatusBadge, Table, Tabs } from '@/components/ui';
import { AdminTable } from '@/components/admin/kit';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { errorMessage, post } from '@/lib/api';
import { formatDate, formatMicros, formatNumber, formatPercent, humanize, timeAgo } from '@/lib/format';

function Summary() {
  const res = useApi<{ data: any }>('/admin/fraud/summary');
  return (
    <Async res={res}>{({ data }) => (
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Unacknowledged alerts" value={formatNumber(data.unacknowledgedAlerts)} />
          <Stat label="Unattributable tokens today" value={formatNumber(data.unattributableTokensToday)} definition="Events whose signed token was missing, forged or expired." />
          {data.cases.map((c: any) => <Stat key={c.status} label={`${humanize(c.status)} cases`} value={formatNumber(c.n)} />)}
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <Card><CardHeader title="Invalid events by reason" /><Table rows={data.reasons} rowKey={(r: any) => r.reason + r.type} empty="No invalid events in this period." columns={[{ key: 'r', header: 'Reason', cell: (r: any) => humanize(r.reason) }, { key: 't', header: 'Event', cell: (r: any) => r.type }, { key: 'n', header: 'Count', align: 'right', cell: (r: any) => formatNumber(r.n) }]} /></Card>
          <Card><CardHeader title="Sites by invalid rate" /><Table rows={data.sites} rowKey={(r: any) => r.id} empty="No traffic." columns={[{ key: 'd', header: 'Site', cell: (r: any) => r.domain }, { key: 'v', header: 'Valid', align: 'right', cell: (r: any) => formatNumber(r.valid) }, { key: 'i', header: 'Invalid rate', align: 'right', cell: (r: any) => (r.invalidRate == null ? '—' : formatPercent(r.invalidRate, 1)) }, { key: 'c', header: 'CTR', align: 'right', cell: (r: any) => (r.ctr == null ? '—' : formatPercent(r.ctr)) }]} /></Card>
        </div>
      </div>
    )}</Async>
  );
}

function Alerts() {
  const res = useApi<{ data: any[] }>('/admin/fraud/alerts');
  const { canAdmin } = useSession();
  return (
    <Card><Async res={res}>{({ data }) => <Table rows={data} rowKey={(r) => r.id} empty="No alerts." columns={[
      { key: 'w', header: 'When', cell: (r) => timeAgo(r.created_at) }, { key: 'k', header: 'Alert', cell: (r) => humanize(r.kind) },
      { key: 's', header: 'Subject', cell: (r) => humanize(r.subject_type) },
      { key: 'd', header: 'Detail', cell: (r) => <code className="break-all text-xs">{JSON.stringify(r.detail ?? {})}</code> },
      { key: 'x', header: '', cell: (r) => (r.acknowledged_at ? <span className="text-xs text-muted">Acknowledged</span> : canAdmin('admin:fraud:manage') && <Button size="sm" variant="ghost" onClick={async () => { await post(`/admin/fraud/alerts/${r.id}/ack`); res.reload(); }}>Acknowledge</Button>) },
    ]} />}</Async></Card>
  );
}

function Events() {
  const [status, setStatus] = useState('invalid');
  const [eventType, setEventType] = useState('');
  return (
    <AdminTable<any> path="/admin/fraud/events" search={false} extra={{ status, eventType: eventType || undefined }} rowKey={(r) => r.id}
      toolbar={<>
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-[160px]"><option value="invalid">Invalid</option><option value="valid">Valid</option></Select>
        <Select aria-label="Event type" value={eventType} onChange={(e) => setEventType(e.target.value)} className="max-w-[160px]"><option value="">All events</option>{['served', 'render', 'viewable', 'click'].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select>
      </>}
      columns={[
        { key: 'w', header: 'When', cell: (r) => formatDate(r.occurred_at, true) }, { key: 't', header: 'Type', cell: (r) => r.type }, { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
        { key: 'r', header: 'Reason', cell: (r) => (r.invalid_reason ? humanize(r.invalid_reason) : '') }, { key: 'sc', header: 'Score', align: 'right', cell: (r) => r.ivt_score },
        { key: 'd', header: 'Site / page host', cell: (r) => <span className="text-xs">{r.domain} / {r.page_host ?? '—'}</span> }, { key: 'i', header: 'IP hash', cell: (r) => <code className="text-xs">{r.ip_hash?.slice(0, 12)}</code> },
        { key: 'c', header: 'Cost', align: 'right', cell: (r) => (r.billable ? formatMicros(r.cost_micros) : '—') },
      ]} />
  );
}

function Cases() {
  const router = useRouter();
  const { canAdmin } = useSession();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ subjectType: 'site', subjectId: '', title: '', severity: 'medium' });
  const [error, setError] = useState<string | null>(null);
  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await post<{ data: { id: string } }>('/admin/fraud/cases', f);
      router.push(`/admin/fraud/cases/${r.data.id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <>
      <AdminTable<any> path="/admin/fraud/cases" statuses={['open', 'investigating', 'confirmed', 'dismissed', 'appealed', 'appeal_upheld', 'appeal_rejected']} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/admin/fraud/cases/${r.id}`)}
        toolbar={canAdmin('admin:fraud:manage') && <Button size="sm" onClick={() => setOpen(true)}>Open a case</Button>}
        columns={[
          { key: 't', header: 'Case', cell: (r) => <span className="font-medium">{r.title}</span> }, { key: 's', header: 'Subject', cell: (r) => humanize(r.subject_type) },
          { key: 'sv', header: 'Severity', cell: (r) => <Badge tone={r.severity === 'high' ? 'danger' : 'warning'}>{r.severity}</Badge> }, { key: 'st', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'a', header: 'Assignee', cell: (r) => r.assignee ?? '—' }, { key: 'c', header: 'Opened', cell: (r) => formatDate(r.created_at) },
        ]} />
      <Modal open={open} onClose={() => setOpen(false)} title="Open an invalid-traffic case" footer={<Button type="submit" form="fc">Open case</Button>}>
        <form id="fc" onSubmit={create} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Subject type" htmlFor="fst"><Select id="fst" value={f.subjectType} onChange={(e) => setF({ ...f, subjectType: e.target.value })}>{['site', 'campaign', 'organization', 'unit'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</Select></Field>
          <Field label="Subject ID" htmlFor="fsi" required><Input id="fsi" required value={f.subjectId} onChange={(e) => setF({ ...f, subjectId: e.target.value })} /></Field>
          <Field label="Title" htmlFor="ft" required><Input id="ft" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Severity" htmlFor="fsv"><Select id="fsv" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{['low', 'medium', 'high'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</Select></Field>
        </form>
      </Modal>
    </>
  );
}

export default function Fraud() {
  const [tab, setTab] = useState('summary');
  return (
    <>
      <PageHeader title="Invalid traffic" description="Automated filters mark events invalid in real time. Investigate patterns here and exclude confirmed invalid activity from billing." />
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'summary', label: 'Summary' }, { id: 'alerts', label: 'Alerts' }, { id: 'cases', label: 'Cases' }, { id: 'events', label: 'Events' }]} />
      <div className="mt-5">{tab === 'summary' ? <Summary /> : tab === 'alerts' ? <Alerts /> : tab === 'cases' ? <Cases /> : <Events />}</div>
    </>
  );
}
