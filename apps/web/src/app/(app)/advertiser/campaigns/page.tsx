'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Plus } from 'lucide-react';
import { Async, Card, EmptyState, Input, LinkButton, PageHeader, Pagination, Select, StatusBadge, Table } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { useOrg } from '@/lib/session';
import { qs } from '@/lib/api';
import { formatDate, formatMicros } from '@/lib/format';

const STATUSES = ['draft', 'pending_approval', 'scheduled', 'active', 'paused', 'rejected', 'completed', 'archived'];

function CampaignList() {
  const org = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const res = useApi<{ data: any[]; meta: { total: number; page: number; pageSize: number } }>(`/orgs/${org.id}/campaigns${qs({ status: status || undefined, q: q || undefined, page, pageSize: 25 })}`);
  const money = (v: string) => formatMicros(v, org.currency);
  return (
    <>
      <PageHeader title="Campaigns" actions={<LinkButton href="/advertiser/campaigns/new"><Plus className="size-4" /> New campaign</LinkButton>} />
      <Card>
        <div className="mb-4 flex flex-wrap gap-3">
          <Input placeholder="Search by name" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-xs" aria-label="Search campaigns" />
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status" className="max-w-[200px]">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </Select>
        </div>
        <Async res={res}>
          {({ data, meta }) => data.length === 0 ? (
            <EmptyState title={status || q ? 'No campaigns match' : 'No campaigns yet'} action={!status && !q && <LinkButton href="/advertiser/campaigns/new">Create a campaign</LinkButton>} />
          ) : (
            <>
              <Table rows={data} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/advertiser/campaigns/${r.id}`)} columns={[
                { key: 'name', header: 'Campaign', cell: (r) => <span className="font-medium">{r.name}</span> },
                { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
                { key: 'model', header: 'Pricing', cell: (r) => `${r.pricingModel.toUpperCase()} ${money(r.rateMicros)}` },
                { key: 'budget', header: 'Budget', align: 'right', cell: (r) => money(r.lifetimeBudgetMicros) },
                { key: 'spent', header: 'Spent', align: 'right', cell: (r) => money(r.spentMicros) },
                { key: 'dates', header: 'Schedule', cell: (r) => `${formatDate(r.startAt)} – ${r.endAt ? formatDate(r.endAt) : 'no end'}` },
              ]} />
              <Pagination page={meta.page} pageSize={meta.pageSize} total={meta.total} onPage={setPage} />
            </>
          )}
        </Async>
      </Card>
    </>
  );
}

export default function Page() {
  return <Suspense><CampaignList /></Suspense>;
}
