'use client';
import { useState } from 'react';
import { Async, Badge, Button, Card, CardHeader, PageHeader, Stat, Tabs } from '@/components/ui';
import { AdminTable, ReasonAction } from '@/components/admin/kit';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { post } from '@/lib/api';
import { formatDate, humanize, timeAgo } from '@/lib/format';

export default function Security() {
  const [tab, setTab] = useState('summary');
  const [k, setK] = useState(0);
  const { canAdmin } = useSession();
  const manage = canAdmin('admin:security:manage');
  const summary = useApi<{ data: any }>(tab === 'summary' ? '/admin/security/summary' : null);
  return (
    <>
      <PageHeader title="Security" description="Sign-in activity, security events, active sessions and API keys. Raw IP addresses are not stored; only salted hashes." />
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'summary', label: 'Summary' }, { id: 'auth', label: 'Sign-in events' }, { id: 'events', label: 'Security events' }, { id: 'sessions', label: 'Sessions' }, { id: 'keys', label: 'API keys' }]} />
      <div className="mt-5">
        {tab === 'summary' && <Async res={summary}>{({ data }) => (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Active sessions" value={data.activeSessions} />
              <Stat label="Staff without two-step verification" value={data.staffWithoutMfa} hint={data.staffWithoutMfa > 0 ? 'Ask them to turn it on' : undefined} />
              {data.authEvents24h.filter((e: any) => /fail|lock/.test(e.type)).map((e: any) => <Stat key={e.type} label={`${humanize(e.type)} (24h)`} value={e.n} />)}
            </div>
            <Card><CardHeader title="Security events, last 24 hours" />{data.securityEvents24h.length === 0 ? <p className="text-sm text-muted">None.</p> : <ul className="space-y-1 text-sm">{data.securityEvents24h.map((e: any) => <li key={e.type + e.severity}><Badge tone={e.severity === 'critical' ? 'danger' : e.severity === 'warning' ? 'warning' : 'neutral'}>{e.severity}</Badge> {humanize(e.type)}: {e.n}</li>)}</ul>}</Card>
          </div>
        )}</Async>}
        {tab === 'auth' && <AdminTable<any> path="/admin/security/auth-events" rowKey={(r) => r.id} columns={[
          { key: 'w', header: 'When', cell: (r) => formatDate(r.created_at, true) }, { key: 't', header: 'Event', cell: (r) => humanize(r.type) }, { key: 'e', header: 'Account', cell: (r) => r.email ?? '—' },
          { key: 'u', header: 'Device', cell: (r) => <span className="line-clamp-1 text-xs">{r.user_agent ?? ''}</span> },
        ]} />}
        {tab === 'events' && <AdminTable<any> path="/admin/security/events" reloadKey={k} search={false} rowKey={(r) => String(r.id)} columns={[
          { key: 'w', header: 'When', cell: (r) => formatDate(r.created_at, true) }, { key: 't', header: 'Event', cell: (r) => humanize(r.type) },
          { key: 's', header: 'Severity', cell: (r) => <Badge tone={r.severity === 'critical' ? 'danger' : r.severity === 'warning' ? 'warning' : 'neutral'}>{r.severity}</Badge> },
          { key: 'd', header: 'Detail', cell: (r) => <code className="break-all text-xs">{r.subject ?? ''} {JSON.stringify(r.detail)}</code> },
          { key: 'x', header: '', cell: (r) => (r.acknowledged_at ? <span className="text-xs text-muted">Acknowledged</span> : manage && <Button size="sm" variant="ghost" onClick={async () => { await post(`/admin/security/events/${r.id}/ack`); setK((x) => x + 1); }}>Acknowledge</Button>) },
        ]} />}
        {tab === 'sessions' && <AdminTable<any> path="/admin/security/sessions" reloadKey={k} search={false} rowKey={(r) => r.id} columns={[
          { key: 'e', header: 'Account', cell: (r) => <span>{r.email}{r.platform_role && <Badge tone="accent" className="ml-1">{humanize(r.platform_role)}</Badge>}</span> },
          { key: 'u', header: 'Device', cell: (r) => <span className="line-clamp-1 text-xs">{r.user_agent ?? ''}</span> }, { key: 'm', header: 'MFA', cell: (r) => (r.mfa_verified ? 'Yes' : 'No') },
          { key: 'l', header: 'Last active', cell: (r) => timeAgo(r.last_seen_at) },
          { key: 'x', header: '', cell: (r) => manage && <ReasonAction label="Revoke" title="Revoke session" path={`/admin/security/sessions/${r.id}/revoke`} onDone={() => setK((x) => x + 1)} /> },
        ]} />}
        {tab === 'keys' && <AdminTable<any> path="/admin/security/api-keys" reloadKey={k} search={false} rowKey={(r) => r.id} columns={[
          { key: 'n', header: 'Key', cell: (r) => <span>{r.name} <code className="text-xs text-muted">{r.prefix}…</code></span> }, { key: 'o', header: 'Organization', cell: (r) => r.org_name },
          { key: 's', header: 'Scopes', cell: (r) => r.scopes.join(', ') }, { key: 'u', header: 'Last used', cell: (r) => (r.last_used_at ? timeAgo(r.last_used_at) : 'Never') },
          { key: 'x', header: '', cell: (r) => (r.revoked_at ? <Badge tone="danger">Revoked</Badge> : manage && <ReasonAction label="Revoke" title="Revoke API key" path={`/admin/security/api-keys/${r.id}/revoke`} danger onDone={() => setK((x) => x + 1)} />) },
        ]} />}
      </div>
    </>
  );
}
