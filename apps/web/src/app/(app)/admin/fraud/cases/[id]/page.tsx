'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Async, Badge, Button, Card, CardHeader, Checkbox, DefinitionList, Field, Input, PageHeader, Select, StatusBadge, Textarea } from '@/components/ui';
import { NotesPanel, ReasonAction, SimpleTable } from '@/components/admin/kit';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { errorMessage, patch, post } from '@/lib/api';
import { formatDate, formatMicros, humanize, timeAgo } from '@/lib/format';

function Exclusion({ c, onDone }: { c: any; onDone: () => void }) {
  const key = c.subject_type === 'site' ? 'siteId' : c.subject_type === 'campaign' ? 'campaignId' : c.subject_type === 'unit' ? 'unitId' : null;
  const [f, setF] = useState({ from: '', to: '', types: ['render', 'viewable', 'click'] as string[] });
  const [preview, setPreview] = useState<{ matched: number; billable: number; billableMicros: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const criteria = () => ({ ...(key ? { [key]: c.subject_id } : {}), from: f.from ? new Date(f.from).toISOString() : undefined, to: f.to ? new Date(f.to).toISOString() : undefined, types: f.types });
  if (!key) return <Card><CardHeader title="Exclude events" /><p className="text-sm text-muted">Exclusions are made per site, campaign or placement. Open a case on the specific subject.</p></Card>;
  return (
    <Card>
      <CardHeader title="Exclude events from billing" description="Matching events become non-billable. Already settled charges are reversed with new ledger entries; nothing is deleted." />
      {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From" htmlFor="xf"><Input id="xf" type="datetime-local" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="To" htmlFor="xt"><Input id="xt" type="datetime-local" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
      </div>
      <div className="mt-3 flex gap-4">{['render', 'viewable', 'click'].map((t) => <Checkbox key={t} label={humanize(t)} checked={f.types.includes(t)} onChange={(v) => setF({ ...f, types: v ? [...f.types, t] : f.types.filter((x) => x !== t) })} />)}</div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={async () => { setError(null); try { const r = await post<{ data: any }>(`/admin/fraud/cases/${c.id}/exclude`, { criteria: criteria(), reason: 'Preview of matching events', dryRun: true }); setPreview(r.data); } catch (e) { setError(errorMessage(e)); } }}>Preview</Button>
        {preview && <ReasonAction label={`Exclude ${preview.matched} events`} title="Exclude events" path="" variant="danger" danger onDone={() => { setPreview(null); onDone(); }} description={`${preview.billable} billable events worth ${formatMicros(preview.billableMicros)} will be reversed.`} run={(reason) => post(`/admin/fraud/cases/${c.id}/exclude`, { criteria: criteria(), reason, dryRun: false })} />}
      </div>
      {preview && <p className="mt-2 text-sm text-muted">{preview.matched} matching events, {preview.billable} billable ({formatMicros(preview.billableMicros)}).</p>}
    </Card>
  );
}

export default function FraudCase() {
  const { id } = useParams<{ id: string }>();
  const { canAdmin } = useSession();
  const res = useApi<{ data: any }>(`/admin/fraud/cases/${id}`);
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState<string | null>(null);
  const manage = canAdmin('admin:fraud:manage');
  return (
    <Async res={res}>
      {({ data: c }) => (
        <>
          <PageHeader back={{ href: '/admin/fraud', label: 'Invalid traffic' }} title={<span className="flex items-center gap-2">{c.title} <StatusBadge status={c.status} /></span>} description={`${humanize(c.subject_type)} ${c.subject_id}`} />
          {error && <Alert tone="danger" className="mb-4">{error}</Alert>}
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-5">
              <Card>
                <CardHeader title="Case" />
                <DefinitionList items={[['Severity', <Badge key="s" tone={c.severity === 'high' ? 'danger' : 'warning'}>{c.severity}</Badge>], ['Opened', formatDate(c.created_at, true)], ['Outcome', c.outcome ?? '—'], ['Resolved', c.resolved_at ? formatDate(c.resolved_at) : '—']]} />
                {Object.keys(c.signals ?? {}).length > 0 && <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs">{JSON.stringify(c.signals, null, 2)}</pre>}
                {manage && !['confirmed', 'dismissed'].includes(c.status) && (
                  <div className="mt-4 space-y-3">
                    <Field label="Outcome" htmlFor="oc" hint="Shown to the affected organization when confirmed."><Textarea id="oc" rows={3} value={outcome} onChange={(e) => setOutcome(e.target.value)} /></Field>
                    <div className="flex flex-wrap gap-2">
                      {c.status === 'open' && <Button size="sm" variant="secondary" onClick={async () => { try { await patch(`/admin/fraud/cases/${id}`, { status: 'investigating' }); res.reload(); } catch (e) { setError(errorMessage(e)); } }}>Start investigating</Button>}
                      <Button size="sm" variant="danger" disabled={outcome.trim().length < 3} onClick={async () => { try { await patch(`/admin/fraud/cases/${id}`, { status: 'confirmed', outcome }); res.reload(); } catch (e) { setError(errorMessage(e)); } }}>Confirm invalid traffic</Button>
                      <Button size="sm" variant="secondary" disabled={outcome.trim().length < 3} onClick={async () => { try { await patch(`/admin/fraud/cases/${id}`, { status: 'dismissed', outcome }); res.reload(); } catch (e) { setError(errorMessage(e)); } }}>Dismiss</Button>
                    </div>
                  </div>
                )}
              </Card>
              {c.appeal_text && (
                <Card>
                  <CardHeader title="Appeal" />
                  <p className="whitespace-pre-wrap text-sm">{c.appeal_text}</p>
                  {manage && c.status === 'appealed' && (
                    <div className="mt-3 flex gap-2">
                      <ReasonAction label="Uphold appeal" title="Uphold the appeal" path="" onDone={res.reload} run={(o) => post(`/admin/fraud/cases/${id}/appeal-decision`, { decision: 'upheld', outcome: o })} description="At least 10 characters. Shown to the publisher." />
                      <ReasonAction label="Reject appeal" title="Reject the appeal" path="" danger onDone={res.reload} run={(o) => post(`/admin/fraud/cases/${id}/appeal-decision`, { decision: 'rejected', outcome: o })} />
                    </div>
                  )}
                </Card>
              )}
              {manage && <Exclusion c={c} onDone={res.reload} />}
            </div>
            <div className="space-y-5">
              <Card>
                <CardHeader title="Exclusions" />
                <SimpleTable rows={c.exclusions} rowKey={(r: any) => r.id} empty="No exclusions." columns={[{ key: 'w', header: 'When', cell: (r: any) => timeAgo(r.created_at) }, { key: 'n', header: 'Events', align: 'right', cell: (r: any) => r.excluded_events }, { key: 'r', header: 'Reversed', align: 'right', cell: (r: any) => formatMicros(r.reversed_micros) }, { key: 'b', header: 'By', cell: (r: any) => r.actor }]} />
              </Card>
              <Card>
                <CardHeader title="History" />
                <SimpleTable rows={c.history} rowKey={(r: any) => r.created_at + r.action} columns={[{ key: 'w', header: 'When', cell: (r: any) => timeAgo(r.created_at) }, { key: 'a', header: 'Action', cell: (r: any) => r.action }, { key: 'b', header: 'By', cell: (r: any) => r.actor ?? 'System' }, { key: 'r', header: 'Reason', cell: (r: any) => r.reason ?? '' }]} />
              </Card>
              <NotesPanel subjectType="fraud_case" subjectId={c.id} />
            </div>
          </div>
        </>
      )}
    </Async>
  );
}
