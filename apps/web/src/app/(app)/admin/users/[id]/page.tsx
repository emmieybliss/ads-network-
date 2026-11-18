'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { PLATFORM_ROLES } from '@blissnova/shared';
import { Alert, Async, Badge, Button, Card, CardHeader, DefinitionList, Field, PageHeader, ReasonDialog, Select, StatusBadge } from '@/components/ui';
import { NotesPanel, ReasonAction, SimpleTable } from '@/components/admin/kit';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { put } from '@/lib/api';
import { formatDate, humanize, timeAgo } from '@/lib/format';

const AUTH_EVENT_LABELS: Record<string, string> = {
  mfa_enabled: '2-step verification turned on',
  mfa_disabled: '2-step verification turned off',
  mfa_backup_code_used: 'Backup code used',
  mfa_reset: '2-step verification reset by an admin',
};

export default function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const { canAdmin, me } = useSession();
  const res = useApi<{ data: any }>(`/admin/users/${id}`);
  const [role, setRole] = useState<string | null>(null);
  return (
    <Async res={res}>
      {({ data: u }) => (
        <>
          <PageHeader back={{ href: '/admin/users', label: 'Users' }} title={<span className="flex items-center gap-2">{u.name} <StatusBadge status={u.status} /></span>} description={u.email}
            actions={u.id !== me?.id && canAdmin('admin:users:manage') && (
              <div className="flex flex-wrap gap-2">
                {u.status === 'active' ? <ReasonAction label="Suspend" title={`Suspend ${u.email}`} path={`/admin/users/${id}/suspend`} variant="danger" danger onDone={res.reload} description="Signs the user out everywhere and blocks sign-in." />
                  : <ReasonAction label="Reactivate" title={`Reactivate ${u.email}`} path={`/admin/users/${id}/reactivate`} onDone={res.reload} />}
                <ReasonAction label="Sign out everywhere" title="Revoke all sessions" path={`/admin/users/${id}/revoke-sessions`} onDone={res.reload} />
                {u.mfa_enabled && <ReasonAction label="Reset 2-step verification" title={`Reset 2-step verification for ${u.email}`} path={`/admin/users/${id}/mfa/reset`} variant="danger" danger onDone={res.reload} description="For someone who lost their phone and their backup codes. Check who they are first (for example from their account email and recent activity). This turns 2-step verification off, removes their backup codes and trusted devices, signs them out everywhere and emails them." />}
              </div>
            )} />
          {u.suspended_reason && <Alert tone="danger" className="mb-4" title="Suspended">{u.suspended_reason}</Alert>}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Account" />
              <DefinitionList items={[
                ['Staff role', u.platform_role ? <Badge key="r" tone="accent">{humanize(u.platform_role)}</Badge> : 'None (customer)'],
                ['Two-step verification', u.mfa ? <span key="m">On{u.mfa.enabledAt ? ` since ${formatDate(u.mfa.enabledAt)}` : ''} · {u.mfa.backupCodesLeft} backup codes left · {u.mfa.trustedDevices} trusted {u.mfa.trustedDevices === 1 ? 'device' : 'devices'}</span> : 'Off'], ['Email verified', u.email_verified_at ? formatDate(u.email_verified_at) : 'No'],
                ['Last sign-in', u.last_login_at ? formatDate(u.last_login_at, true) : 'Never'], ['Joined', formatDate(u.created_at)],
              ]} />
              {canAdmin('admin:roles:manage') && u.id !== me?.id && (
                <div className="mt-4 flex items-end gap-2">
                  <Field label="Change staff role" htmlFor="role"><Select id="role" value={role ?? u.platform_role ?? ''} onChange={(e) => setRole(e.target.value)}><option value="">None (customer)</option>{PLATFORM_ROLES.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}</Select></Field>
                </div>
              )}
            </Card>
            <Card>
              <CardHeader title="Organizations" />
              <SimpleTable rows={u.organizations} rowKey={(r: any) => r.id} columns={[
                { key: 'n', header: 'Name', cell: (r: any) => <Link className="text-primary hover:underline" href={`/admin/orgs/${r.id}`}>{r.name}</Link> },
                { key: 't', header: 'Type', cell: (r: any) => humanize(r.type) }, { key: 'r', header: 'Role', cell: (r: any) => humanize(r.role) }, { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> },
              ]} />
            </Card>
            <Card>
              <CardHeader title="Active sessions" />
              <SimpleTable rows={u.sessions} rowKey={(r: any) => r.id} columns={[{ key: 'u', header: 'Device', cell: (r: any) => <span className="line-clamp-1">{r.user_agent ?? 'Unknown'}</span> }, { key: 'l', header: 'Last active', cell: (r: any) => timeAgo(r.last_seen_at) }]} />
            </Card>
            <Card>
              <CardHeader title="Sign-in activity" />
              <SimpleTable rows={u.authEvents.slice(0, 15)} rowKey={(r: any) => r.created_at + r.type} columns={[{ key: 't', header: 'Event', cell: (r: any) => AUTH_EVENT_LABELS[r.type] ?? humanize(r.type) }, { key: 'w', header: 'When', cell: (r: any) => timeAgo(r.created_at) }]} />
            </Card>
            <Card>
              <CardHeader title="Actions by this user" />
              <SimpleTable rows={u.activity.slice(0, 20)} rowKey={(r: any) => r.created_at + r.action} columns={[{ key: 'a', header: 'Action', cell: (r: any) => r.action }, { key: 'w', header: 'When', cell: (r: any) => timeAgo(r.created_at) }]} />
            </Card>
            <NotesPanel subjectType="user" subjectId={u.id} />
          </div>
          <ReasonDialog open={role !== null && role !== (u.platform_role ?? '')} onClose={() => setRole(null)} title={`Change staff role to ${role ? humanize(role) : 'none'}`} confirmLabel="Change role"
            description="Staff roles grant access to the admin control center. This is recorded in the audit log."
            onConfirm={async (reason) => { await put(`/admin/users/${id}/role`, { platformRole: role || null, reason }); setRole(null); res.reload(); }} />
        </>
      )}
    </Async>
  );
}
