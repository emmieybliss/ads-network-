'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PLATFORM_ROLES } from '@blissnova/shared';
import { Badge, PageHeader, Select, StatusBadge } from '@/components/ui';
import { AdminTable } from '@/components/admin/kit';
import { formatDate, humanize, timeAgo } from '@/lib/format';

export default function Users() {
  const router = useRouter();
  const [role, setRole] = useState('');
  return (
    <>
      <PageHeader title="Users" description="Everyone with an account: customers and staff." />
      <AdminTable<any> path="/admin/users" extra={{ role: role || undefined }} statuses={['active', 'suspended']} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/admin/users/${r.id}`)}
        toolbar={<Select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)} className="max-w-[200px]"><option value="">All roles</option><option value="none">Customers only</option>{PLATFORM_ROLES.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}</Select>}
        columns={[
          { key: 'n', header: 'User', cell: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-muted">{r.email}</p></div> },
          { key: 'r', header: 'Staff role', cell: (r) => (r.platform_role ? <Badge tone="accent">{humanize(r.platform_role)}</Badge> : '—') },
          { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'm', header: 'MFA', cell: (r) => (r.mfa_enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>) },
          { key: 'e', header: 'Email', cell: (r) => (r.email_verified_at ? 'Verified' : <Badge tone="warning">Unverified</Badge>) },
          { key: 'o', header: 'Orgs', align: 'right', cell: (r) => r.org_count },
          { key: 'l', header: 'Last sign-in', cell: (r) => (r.last_login_at ? timeAgo(r.last_login_at) : 'Never') },
          { key: 'c', header: 'Joined', cell: (r) => formatDate(r.created_at) },
        ]} />
    </>
  );
}
