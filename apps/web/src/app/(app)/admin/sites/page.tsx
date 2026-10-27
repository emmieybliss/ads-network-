'use client';
import { useRouter } from 'next/navigation';
import { SITE_STATUSES, SITE_STATUS_LABELS, type SiteStatus } from '@blissnova/shared';
import { Badge, PageHeader, StatusBadge } from '@/components/ui';
import { AdminTable } from '@/components/admin/kit';
import { formatDate, humanize } from '@/lib/format';

export default function AdminSites() {
  const router = useRouter();
  return (
    <>
      <PageHeader title="Publisher sites" description="Review queue and inventory. Verification proves domain control; approval is a separate editorial and quality decision." />
      <AdminTable<any> path="/admin/sites" statuses={[...SITE_STATUSES]} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/admin/sites/${r.id}`)}
        columns={[
          { key: 'd', header: 'Site', cell: (r) => <div><p className="font-medium">{r.domain}</p><p className="text-xs text-muted">{r.name}</p></div> },
          { key: 'o', header: 'Publisher', cell: (r) => <span>{r.orgName} {r.orgStatus !== 'approved' && <Badge tone="warning">{r.orgStatus}</Badge>}</span> },
          { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} label={SITE_STATUS_LABELS[r.status as SiteStatus]} /> },
          { key: 'v', header: 'Verification', cell: (r) => (r.verifiedAt ? <span className="flex gap-1">{humanize(r.verificationMethod)}{r.verificationSimulated && <Badge tone="warning">Simulated</Badge>}</span> : <span className="text-muted">Not verified</span>) },
          { key: 'c', header: 'Category', cell: (r) => humanize(r.category) },
          { key: 'u', header: 'Active placements', align: 'right', cell: (r) => r.activeUnits },
          { key: 'sb', header: 'Submitted', cell: (r) => (r.submittedAt ? formatDate(r.submittedAt) : '—') },
        ]} />
    </>
  );
}
