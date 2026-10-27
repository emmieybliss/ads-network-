'use client';
import { useRouter } from 'next/navigation';
import { CAMPAIGN_STATUSES } from '@blissnova/shared';
import { PageHeader, StatusBadge } from '@/components/ui';
import { AdminTable } from '@/components/admin/kit';
import { formatDate, formatMicros } from '@/lib/format';

export default function AdminCampaigns() {
  const router = useRouter();
  return (
    <>
      <PageHeader title="Campaigns" description="Approve submitted campaigns and oversee delivery across the network." />
      <AdminTable<any> path="/admin/campaigns" statuses={[...CAMPAIGN_STATUSES]} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/admin/campaigns/${r.id}`)}
        columns={[
          { key: 'n', header: 'Campaign', cell: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-muted">{r.orgName}</p></div> },
          { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'p', header: 'Pricing', cell: (r) => `${r.pricingModel.toUpperCase()} ${formatMicros(r.rateMicros, r.currency)}` },
          { key: 'b', header: 'Spent / budget', align: 'right', cell: (r) => `${formatMicros(r.spentMicros, r.currency)} / ${formatMicros(r.lifetimeBudgetMicros, r.currency)}` },
          { key: 'sb', header: 'Submitted', cell: (r) => (r.submittedAt ? formatDate(r.submittedAt) : '—') },
          { key: 'sc', header: 'Schedule', cell: (r) => `${formatDate(r.startAt)} – ${r.endAt ? formatDate(r.endAt) : 'open'}` },
        ]} />
    </>
  );
}
