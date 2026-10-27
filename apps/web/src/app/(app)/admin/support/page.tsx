'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageHeader, StatusBadge, Tabs, Badge } from '@/components/ui';
import { AdminTable, ReasonAction } from '@/components/admin/kit';
import { patch } from '@/lib/api';
import { formatDate, humanize, timeAgo } from '@/lib/format';

export default function AdminSupport() {
  const router = useRouter();
  const [tab, setTab] = useState('cases');
  const [k, setK] = useState(0);
  return (
    <>
      <PageHeader title="Support" description="Customer requests and public abuse reports." />
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'cases', label: 'Support requests' }, { id: 'abuse', label: 'Abuse reports' }]} />
      <div className="mt-5">
        {tab === 'cases' ? (
          <AdminTable<any> path="/admin/support-cases" statuses={['open', 'waiting_on_staff', 'waiting_on_customer', 'resolved', 'closed']} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/admin/support/${r.id}`)} columns={[
            { key: 's', header: 'Subject', cell: (r) => <div><p className="font-medium">{r.subject}</p><p className="text-xs text-muted">{r.orgName} · {r.openedBy}</p></div> },
            { key: 'c', header: 'Category', cell: (r) => humanize(r.category) },
            { key: 'p', header: 'Priority', cell: (r) => <Badge tone={r.priority === 'urgent' ? 'danger' : r.priority === 'high' ? 'warning' : 'neutral'}>{r.priority}</Badge> },
            { key: 'st', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            { key: 'a', header: 'Assignee', cell: (r) => r.assignedName ?? '—' },
            { key: 'u', header: 'Updated', cell: (r) => timeAgo(r.updatedAt) },
          ]} />
        ) : (
          <AdminTable<any> path="/admin/abuse-reports" reloadKey={k} search={false} statuses={['open', 'investigating', 'resolved', 'dismissed']} rowKey={(r) => r.id} columns={[
            { key: 'w', header: 'Received', cell: (r) => formatDate(r.created_at) },
            { key: 's', header: 'About', cell: (r) => <span>{humanize(r.subject_type)} <span className="text-xs text-muted">{r.subject_ref}</span></span> },
            { key: 'b', header: 'Report', cell: (r) => <span className="line-clamp-3 text-sm">{r.body}</span> },
            { key: 'e', header: 'Reporter', cell: (r) => r.reporter_email ?? 'Anonymous' },
            { key: 'st', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            { key: 'x', header: '', cell: (r) => !['resolved', 'dismissed'].includes(r.status) && (
              <span className="flex gap-1">
                <ReasonAction label="Resolve" title="Resolve report" path="" onDone={() => setK((x) => x + 1)} run={(resolution) => patch(`/admin/abuse-reports/${r.id}`, { status: 'resolved', resolution })} />
                <ReasonAction label="Dismiss" title="Dismiss report" path="" onDone={() => setK((x) => x + 1)} run={(resolution) => patch(`/admin/abuse-reports/${r.id}`, { status: 'dismissed', resolution })} />
              </span>
            ) },
          ]} />
        )}
      </div>
    </>
  );
}
