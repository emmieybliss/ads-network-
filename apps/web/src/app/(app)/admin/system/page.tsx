'use client';
import { Async, Badge, Card, CardHeader, DefinitionList, PageHeader, StatusBadge } from '@/components/ui';
import { AdminTable } from '@/components/admin/kit';
import { useApi } from '@/lib/hooks';
import { formatDate, humanize, timeAgo } from '@/lib/format';

export default function System() {
  const res = useApi<{ data: any }>('/admin/system');
  return (
    <>
      <PageHeader title="System health" description="Services, background jobs, migrations and integrations for this installation." />
      <Async res={res}>
        {({ data: d }) => (
          <div className="space-y-5">
            <div className="grid gap-5 lg:grid-cols-2">
              <Card>
                <CardHeader title="Services" />
                <DefinitionList items={[
                  ['Environment', <Badge key="e" tone={d.environment === 'production' ? 'success' : 'warning'}>{d.environment}</Badge>],
                  ['Database', <Badge key="d" tone={d.health.database === 'ok' ? 'success' : 'danger'}>{d.health.database}</Badge>],
                  ['Redis', <Badge key="r" tone={d.health.redis === 'ok' ? 'success' : 'danger'}>{d.health.redis}</Badge>],
                  ['Worker', d.health.worker.lastHeartbeat ? `Last heartbeat ${timeAgo(d.health.worker.lastHeartbeat)}` : d.eventProcessing === 'inline' ? 'Inline processing (no worker needed)' : 'No heartbeat'],
                  ['Event processing', humanize(d.eventProcessing)], ['Public site URL', d.publicUrls.site], ['Public API URL', d.publicUrls.api], ['Country header', d.geoHeader ?? 'Not configured'], ['GeoIP database', d.geoDatabase ?? 'Not configured'],
                  ['Email', `${d.email.provider}${d.email.configured ? '' : ' (not configured)'}`],
                ]} />
              </Card>
              <Card>
                <CardHeader title="Queues" />
                <table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted"><th className="py-1">Queue</th><th>Waiting</th><th>Active</th><th>Failed</th><th>Done</th></tr></thead>
                  <tbody>{Object.entries(d.health.queues as Record<string, any>).map(([n, q]) => <tr key={n} className="border-t border-border"><td className="py-1.5">{humanize(n)}</td>{typeof q === 'string' ? <td colSpan={4} className="text-muted">{q}</td> : <><td>{q.waiting}</td><td>{q.active}</td><td className={q.failed ? 'text-danger' : ''}>{q.failed}</td><td>{q.completed}</td></>}</tr>)}</tbody>
                </table>
              </Card>
              <Card>
                <CardHeader title="Payment providers" />
                <ul className="space-y-1 text-sm">{d.payments.map((p: any) => <li key={p.id} className="flex items-center gap-2"><Badge tone={p.configured ? 'success' : 'neutral'}>{p.configured ? 'Configured' : 'Off'}</Badge>{p.label}{p.id === 'dev_simulated' && <Badge tone="warning">Development only</Badge>}</li>)}</ul>
              </Card>
              <Card>
                <CardHeader title="Database migrations" />
                <ul className="space-y-1 text-sm">{d.migrations.map((m: any) => <li key={m.id} className="flex items-center gap-2"><Badge tone={m.applied ? 'success' : 'danger'}>{m.applied ? 'Applied' : 'Pending'}</Badge><code className="text-xs">{m.id}</code></li>)}</ul>
              </Card>
            </div>
            <div>
              <h2 className="mb-3 font-semibold">Email outbox</h2>
              <AdminTable<any> path="/admin/email-outbox" search={false} statuses={['pending', 'sent', 'failed']} rowKey={(r) => r.id} columns={[
                { key: 'w', header: 'Created', cell: (r) => formatDate(r.created_at, true) }, { key: 't', header: 'To', cell: (r) => r.to_address }, { key: 's', header: 'Subject', cell: (r) => r.subject },
                { key: 'st', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> }, { key: 'e', header: 'Error', cell: (r) => <span className="text-xs text-danger">{r.last_error ?? ''}</span> },
              ]} />
            </div>
          </div>
        )}
      </Async>
    </>
  );
}
