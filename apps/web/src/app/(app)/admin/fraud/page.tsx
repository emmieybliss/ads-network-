'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Alert, Async, Badge, Button, Card, CardHeader, Field, Input, Modal, PageHeader, ReasonDialog, Select, Stat, StatusBadge, Table, Tabs } from '@/components/ui';
import { QUALITY_LABELS, QUALITY_TONES, RULE_LABELS, reasonLabel, signalLabel } from '@/lib/ivt';
import { AdminTable } from '@/components/admin/kit';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { errorMessage, patch, post } from '@/lib/api';
import { formatDate, formatMicros, formatNumber, formatPercent, humanize, timeAgo } from '@/lib/format';

function Summary() {
  const res = useApi<{ data: any }>('/admin/fraud/summary');
  return (
    <Async res={res}>{({ data }) => (
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Network IVT rate (7 days)" value={data.networkIvtRate == null ? '—' : formatPercent(data.networkIvtRate, 1)} definition="Rendered impressions marked invalid, as a share of all rendered impressions." />
          <Stat label="Waiting for review" value={formatNumber(data.reviewQueue)} />
          <Stat label="Automatic clawbacks (7 days)" value={formatNumber(data.automaticClawbacks.count)} hint={`${formatMicros(data.automaticClawbacks.publisherMicros)} of publisher earnings`} />
          <Stat label="Unacknowledged alerts" value={formatNumber(data.unacknowledgedAlerts)} />
        </div>
        <Card>
          <CardHeader title="Detection" description="What the filters check on every impression and click. Change thresholds under Settings, Invalid traffic." />
          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <Check on={data.detection.datacenterFilter} title="Cloud and hosting networks" detail={`${data.detection.datacenterSources.join(', ') || 'No bundled list'} (updated ${data.detection.datacenterUpdated})${data.detection.extraRanges ? `, plus ${data.detection.extraRanges} added ranges` : ''}${data.detection.trustedRanges ? `, ${data.detection.trustedRanges} trusted` : ''}`} />
            <Check on={data.detection.automationSignals} title="Automated browsers" detail="WebDriver, headless windows, automation tools, script clicks, missing browser headers" />
            <Check on title="Click timing and rates" detail="Too-fast clicks, bursts per visitor and per network, clicks on a machine-regular rhythm" />
            <Check on title="Known bots and crawlers" detail="Bot user agents, forged or replayed tracking tokens, ads shown on other domains" />
            <Check on={data.detection.autoClawback} title="Automatic clawback" detail="Earnings still on hold are reversed when traffic is proven invalid after the fact" />
            <Check on title="Anomaly score" detail={`Weak signals add up; at ${data.detection.scoreThreshold} or more an event is invalid`} />
          </div>
        </Card>
        <div className="grid gap-5 lg:grid-cols-2">
          <Card><CardHeader title="Invalid events by reason" /><Table rows={data.reasons} rowKey={(r: any) => r.reason + r.type} empty="No invalid events in this period." columns={[{ key: 'r', header: 'Reason', cell: (r: any) => reasonLabel(r.reason) }, { key: 't', header: 'Event', cell: (r: any) => r.type }, { key: 'n', header: 'Count', align: 'right', cell: (r: any) => formatNumber(r.n) }]} /></Card>
          <Card><CardHeader title="Sites by invalid rate" /><Table rows={data.sites} rowKey={(r: any) => r.id} empty="No traffic." columns={[{ key: 'd', header: 'Site', cell: (r: any) => r.domain }, { key: 'v', header: 'Valid', align: 'right', cell: (r: any) => formatNumber(r.valid) }, { key: 'i', header: 'Invalid rate', align: 'right', cell: (r: any) => (r.invalidRate == null ? '—' : formatPercent(r.invalidRate, 1)) }, { key: 'c', header: 'CTR', align: 'right', cell: (r: any) => (r.ctr == null ? '—' : formatPercent(r.ctr)) }]} /></Card>
        </div>
      </div>
    )}</Async>
  );
}

function Check({ on = true, title, detail }: { on?: boolean; title: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2"><span className="font-medium">{title}</span><Badge tone={on ? 'success' : 'neutral'}>{on ? 'On' : 'Off'}</Badge></div>
      <p className="mt-1 text-xs text-muted">{detail}</p>
    </div>
  );
}

function Queue() {
  const res = useApi<{ data: any[] }>('/admin/fraud/queue');
  const { canAdmin } = useSession();
  const router = useRouter();
  const [claw, setClaw] = useState<any | null>(null);
  const [dismiss, setDismiss] = useState<any | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const manage = canAdmin('admin:fraud:manage');
  return (
    <div className="space-y-4">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Async res={res}>{({ data }) => data.length === 0 ? (
        <Card><p className="text-sm text-muted">Nothing is waiting for a decision. The sweep opens a case here when a publisher's invalid-traffic rate is too high or when invalid traffic is found in earnings that were already released.</p></Card>
      ) : (
        <div className="space-y-3">
          {data.map((c) => (
            <Card key={c.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={c.severity === 'high' ? 'danger' : c.severity === 'medium' ? 'warning' : 'neutral'}>{humanize(c.severity)}</Badge>
                    <StatusBadge status={c.status} />
                    <Badge tone={c.source === 'auto' ? 'info' : 'neutral'}>{c.source === 'auto' ? `Automatic: ${RULE_LABELS[c.kind] ?? humanize(c.kind)}` : 'Opened by staff'}</Badge>
                  </div>
                  <Link href={`/admin/fraud/cases/${c.id}`} className="block font-medium hover:underline">{c.title}</Link>
                  <p className="text-sm text-fg-2">{c.publisher_name ?? humanize(c.subject_type)}{c.site_domain ? ` · ${c.site_domain}` : ''} · opened {timeAgo(c.created_at)}</p>
                  <Facts signals={c.signals} />
                  {c.appeal_text && <p className="text-sm"><span className="font-medium">Appeal:</span> {c.appeal_text}</p>}
                </div>
                <div className="text-right">
                  {c.criteria && <><div className="text-xs text-muted">Earnings affected</div><div className="text-lg font-semibold">{formatMicros(c.estimated_micros)}</div></>}
                  {manage && c.status !== 'appealed' && (
                    <div className="mt-2 flex flex-wrap justify-end gap-2">
                      {c.criteria && Number(c.estimated_micros) > 0 && <Button size="sm" variant="danger" onClick={() => setClaw(c)}>Claw back</Button>}
                      <Button size="sm" variant="secondary" onClick={() => setDismiss(c)}>Dismiss</Button>
                    </div>
                  )}
                  {manage && c.status === 'appealed' && <Button size="sm" className="mt-2" variant="secondary" onClick={() => router.push(`/admin/fraud/cases/${c.id}`)}>Decide appeal</Button>}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}</Async>
      <ReasonDialog open={!!claw} onClose={() => setClaw(null)} danger title="Claw back and confirm" confirmLabel="Claw back"
        description={claw && <>This removes the matching events from billing, gives the advertiser's spend back and reverses about <b>{formatMicros(claw.estimated_micros)}</b> of publisher earnings. The publisher is told and can appeal once.</>}
        onConfirm={async (reason) => {
          const r = await post<{ data: { excluded: number; publisherMicros: string } }>(`/admin/fraud/cases/${claw.id}/clawback`, { reason });
          setNotice({ tone: 'success', text: `Removed ${formatNumber(r.data.excluded)} events and ${formatMicros(r.data.publisherMicros)} of publisher earnings.` });
          setClaw(null);
          res.reload();
        }} />
      <ReasonDialog open={!!dismiss} onClose={() => setDismiss(null)} title="Dismiss this case" confirmLabel="Dismiss" description="Nothing is removed from billing. Record why the traffic is acceptable."
        onConfirm={async (reason) => {
          await patch(`/admin/fraud/cases/${dismiss.id}`, { status: 'dismissed', outcome: reason });
          setDismiss(null);
          res.reload();
        }} />
    </div>
  );
}

function Facts({ signals }: { signals: Record<string, unknown> | null }) {
  if (!signals) return null;
  const items: string[] = [];
  if (signals.ivtRate != null) items.push(`IVT rate ${formatPercent(Number(signals.ivtRate), 1)}`);
  if (signals.rendered != null) items.push(`${formatNumber(Number(signals.rendered))} impressions`);
  if (signals.topReason) items.push(`mostly ${reasonLabel(String(signals.topReason)).toLowerCase()}`);
  if (signals.suspiciousEvents != null) items.push(`${formatNumber(Number(signals.suspiciousEvents))} doubtful events that passed`);
  if (signals.visitors != null) items.push(`${formatNumber(Number(signals.visitors))} visitors`);
  if (signals.events != null) items.push(`${formatNumber(Number(signals.events))} events`);
  if (!items.length) return null;
  return <p className="text-xs text-muted">{items.join(' · ')}</p>;
}

function Publishers() {
  const res = useApi<{ data: any[]; meta: any }>('/admin/fraud/publishers');
  return (
    <Card>
      <Async res={res}>{({ data, meta }) => (
        <>
          <CardHeader title="Invalid traffic by publisher" description={`Last 7 days against the 7 days before. A publisher needs review at ${meta.reviewAtPercent}% or more with at least ${formatNumber(meta.minImpressions)} impressions; the sweep opens a case automatically.`} />
          <Table rows={data} rowKey={(r) => r.orgId} empty="No publisher traffic in this period." columns={[
            { key: 'n', header: 'Publisher', cell: (r) => <span className="font-medium">{r.name}</span> },
            { key: 'st', header: 'Status', cell: (r) => <Badge tone={QUALITY_TONES[r.status]}>{QUALITY_LABELS[r.status]}</Badge> },
            { key: 'i', header: 'IVT rate', align: 'right', cell: (r) => (r.ivtRate == null ? '—' : formatPercent(r.ivtRate, 1)) },
            { key: 'p', header: 'Trend', align: 'right', cell: (r) => <Trend now={r.ivtRate} before={r.previousRate} /> },
            { key: 'c', header: 'Invalid clicks', align: 'right', cell: (r) => (r.invalidClickRate == null ? '—' : formatPercent(r.invalidClickRate, 1)) },
            { key: 'r', header: 'Impressions', align: 'right', cell: (r) => formatNumber(r.rendered) },
            { key: 't', header: 'Main reason', cell: (r) => <span className="text-xs">{reasonLabel(r.topReason) || '—'}</span> },
            { key: 'cb', header: 'Clawed back', align: 'right', cell: (r) => (Number(r.clawedMicros) ? formatMicros(r.clawedMicros) : '—') },
            { key: 'oc', header: 'Open cases', align: 'right', cell: (r) => r.openCases || '—' },
          ]} />
        </>
      )}</Async>
    </Card>
  );
}

function Trend({ now, before }: { now: number | null; before: number | null }) {
  if (now == null || before == null) return <span className="text-muted">—</span>;
  const d = now - before;
  if (Math.abs(d) < 0.5) return <span className="text-muted">steady</span>;
  return <span className={d > 0 ? 'text-danger' : 'text-success'}>{d > 0 ? '▲' : '▼'} {Math.abs(d).toFixed(1)} pts</span>;
}

function Clawbacks() {
  const res = useApi<{ data: any[] }>('/admin/fraud/clawbacks');
  const { canAdmin } = useSession();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Clawbacks" description="Every exclusion from billing, automatic or by staff. Automatic ones only touch publisher earnings that are still on hold." actions={canAdmin('admin:fraud:manage') && <Button size="sm" variant="secondary" onClick={async () => { const r = await post<{ data: any }>('/admin/fraud/sweep'); setMsg(`Sweep finished: ${r.data.clawbacks} clawbacks, ${r.data.reviewCases} new review cases.`); res.reload(); }}>Run the sweep now</Button>} />
      {msg && <Alert tone="info" className="mb-3">{msg}</Alert>}
      <Async res={res}>{({ data }) => <Table rows={data} rowKey={(r) => r.id} empty="Nothing has been excluded yet." columns={[
        { key: 'w', header: 'When', cell: (r) => formatDate(r.created_at, true) },
        { key: 'p', header: 'Publisher', cell: (r) => r.publisher_name ?? '—' },
        { key: 'b', header: 'By', cell: (r) => (r.automatic ? <Badge tone="info">Automatic</Badge> : r.actor) },
        { key: 'e', header: 'Events', align: 'right', cell: (r) => formatNumber(r.excluded_events) },
        { key: 'r', header: 'Advertiser refund', align: 'right', cell: (r) => formatMicros(r.reversed_micros) },
        { key: 'pm', header: 'Publisher earnings', align: 'right', cell: (r) => formatMicros(r.publisher_micros) },
        { key: 'c', header: 'Case', cell: (r) => (r.case_id ? <Link className="text-primary hover:underline" href={`/admin/fraud/cases/${r.case_id}`}>{r.case_title}</Link> : '—') },
        { key: 's', header: 'Case status', cell: (r) => (r.case_status ? <StatusBadge status={r.case_status} /> : null) },
      ]} />}</Async>
    </Card>
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
        { key: 'r', header: 'Reason', cell: (r) => (r.invalid_reason ? reasonLabel(r.invalid_reason) : '') }, { key: 'sc', header: 'Score', align: 'right', cell: (r) => r.ivt_score },
        { key: 'sg', header: 'Signals', cell: (r) => <span className="text-xs text-fg-2">{[...new Set((r.ivt_signals ?? []).map(signalLabel))].join(', ')}</span> },
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
          { key: 't', header: 'Case', cell: (r) => <span className="font-medium">{r.title}</span> }, { key: 's', header: 'Subject', cell: (r) => r.publisher_name ?? humanize(r.subject_type) },
          { key: 'src', header: 'Opened by', cell: (r) => (r.source === 'auto' ? <Badge tone="info">Automatic</Badge> : 'Staff') },
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

const TABS = [{ id: 'summary', label: 'Summary' }, { id: 'queue', label: 'Review queue' }, { id: 'publishers', label: 'Publishers' }, { id: 'clawbacks', label: 'Clawbacks' }, { id: 'alerts', label: 'Alerts' }, { id: 'cases', label: 'Cases' }, { id: 'events', label: 'Events' }];

export default function Fraud() {
  const [tab, setTab] = useState('summary');
  // Tabs can be linked to (/admin/fraud#queue), e.g. from notifications.
  useEffect(() => { const h = window.location.hash.slice(1); if (TABS.some((t) => t.id === h)) setTab(h); }, []);
  return (
    <>
      <PageHeader title="Invalid traffic" description="Automated filters mark events invalid in real time. Investigate patterns here and exclude confirmed invalid activity from billing." />
      <Tabs active={tab} onChange={(t) => { setTab(t); try { history.replaceState(null, '', `#${t}`); } catch { /* no history */ } }} tabs={TABS} />
      <div className="mt-5">{tab === 'summary' ? <Summary /> : tab === 'queue' ? <Queue /> : tab === 'publishers' ? <Publishers /> : tab === 'clawbacks' ? <Clawbacks /> : tab === 'alerts' ? <Alerts /> : tab === 'cases' ? <Cases /> : <Events />}</div>
    </>
  );
}
