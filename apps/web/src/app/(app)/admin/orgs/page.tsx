'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageHeader, Select, StatusBadge } from '@/components/ui';
import { AdminTable } from '@/components/admin/kit';
import { bpsToPercent, formatDate, humanize } from '@/lib/format';

export default function Orgs() {
  const router = useRouter();
  const [type, setType] = useState('');
  return (
    <>
      <PageHeader title="Organizations" description="Advertiser and publisher accounts. New organizations start pending until reviewed." />
      <AdminTable<any> path="/admin/orgs" extra={{ type: type || undefined }} statuses={['pending', 'approved', 'rejected', 'suspended']} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/admin/orgs/${r.id}`)}
        toolbar={<Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className="max-w-[180px]"><option value="">All types</option><option value="advertiser">Advertisers</option><option value="publisher">Publishers</option></Select>}
        columns={[
          { key: 'n', header: 'Organization', cell: (r) => <span className="font-medium">{r.name}</span> },
          { key: 't', header: 'Type', cell: (r) => humanize(r.type) },
          { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'm', header: 'Members', align: 'right', cell: (r) => r.members },
          { key: 'l', header: 'Live campaigns / approved sites', align: 'right', cell: (r) => (r.type === 'advertiser' ? r.live_campaigns : r.approved_sites) },
          { key: 'rs', header: 'Revenue share', cell: (r) => (r.type === 'publisher' ? (r.revenue_share_bps != null ? bpsToPercent(r.revenue_share_bps) : 'Default') : '—') },
          { key: 'c', header: 'Created', cell: (r) => formatDate(r.created_at) },
        ]} />
    </>
  );
}
