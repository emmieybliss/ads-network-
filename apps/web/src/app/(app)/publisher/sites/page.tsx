'use client';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { SITE_STATUS_LABELS, type SiteStatus } from '@blissnova/shared';
import { Async, Badge, Card, EmptyState, LinkButton, PageHeader, StatusBadge, Table } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { useOrg } from '@/lib/session';
import { formatDate, humanize } from '@/lib/format';

const NEXT_STEP: Record<string, string> = {
  draft: 'Verify ownership', verification_pending: 'Finish verification', verified: 'Submit for review', submitted: 'Waiting for review',
  under_review: 'In review', approved: 'Install the ad tag', rejected: 'Review feedback and resubmit', suspended: 'Contact support',
};

export default function Sites() {
  const org = useOrg();
  const router = useRouter();
  const res = useApi<{ data: any[] }>(`/orgs/${org.id}/sites`);
  return (
    <>
      <PageHeader title="Websites" description="Draft → verify ownership → submit → review → approved. Only approved sites serve ads." actions={<LinkButton href="/publisher/sites/new"><Plus className="size-4" /> Add website</LinkButton>} />
      <Card>
        <Async res={res}>
          {({ data }) => data.length === 0 ? <EmptyState title="No websites yet" action={<LinkButton href="/publisher/sites/new">Add website</LinkButton>} /> : (
            <Table rows={data} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/publisher/sites/${r.id}`)} columns={[
              { key: 'n', header: 'Website', cell: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-muted">{r.domain}</p></div> },
              { key: 's', header: 'Status', cell: (r) => <span className="flex flex-wrap gap-1"><StatusBadge status={r.status} label={SITE_STATUS_LABELS[r.status as SiteStatus]} />{r.verificationSimulated && <Badge tone="warning">Simulated</Badge>}</span> },
              { key: 'x', header: 'Next step', cell: (r) => <span className="text-sm text-fg-2">{NEXT_STEP[r.status]}</span> },
              { key: 'c', header: 'Category', cell: (r) => humanize(r.category) },
              { key: 'u', header: 'Placements', align: 'right', cell: (r) => r.unitCount },
              { key: 'd', header: 'Added', cell: (r) => formatDate(r.createdAt) },
            ]} />
          )}
        </Async>
      </Card>
    </>
  );
}
