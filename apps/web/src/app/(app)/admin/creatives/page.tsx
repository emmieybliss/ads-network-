'use client';
import Link from 'next/link';
import { useState } from 'react';
import { CREATIVE_STATUSES } from '@blissnova/shared';
import { Alert, Async, Badge, Card, EmptyState, PageHeader, Pagination, Select, StatusBadge } from '@/components/ui';
import { ReasonAction, type Paged } from '@/components/admin/kit';
import { CreativePreview } from '@/components/advertiser/CreativeEditor';
import { useApi } from '@/lib/hooks';
import { qs } from '@/lib/api';
import { humanize } from '@/lib/format';

export default function CreativeReview() {
  const [status, setStatus] = useState('pending_review');
  const [page, setPage] = useState(1);
  const res = useApi<Paged<any>>(`/admin/creatives${qs({ status, page, pageSize: 24 })}`);
  return (
    <>
      <PageHeader title="Creative review" description="Check every creative against the creative rules: clear ad labelling, no deception, no prohibited content, safe destination." actions={
        <Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>{CREATIVE_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>
      } />
      <Async res={res}>
        {({ data, meta }) => data.length === 0 ? <Card><EmptyState title="Nothing to review" /></Card> : (
          <>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {data.map((cr) => (
                <Card key={cr.id}>
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div className="min-w-0"><p className="truncate font-medium">{cr.name}</p><p className="truncate text-xs text-muted">{cr.orgName} · <Link className="text-primary hover:underline" href={`/admin/campaigns/${cr.campaignId ?? ''}`}>{cr.campaignName}</Link></p></div>
                    <StatusBadge status={cr.status} />
                  </div>
                  <CreativePreview c={cr} />
                  <p className="mt-2 break-all text-xs text-muted">Destination: {cr.destinationUrl}</p>
                  {cr.version > 1 && <Badge className="mt-2">Version {cr.version}{cr.approvedVersion ? `, v${cr.approvedVersion} serving` : ''}</Badge>}
                  {cr.rejectionReason && cr.status === 'rejected' && <Alert tone="danger" className="mt-2">{cr.rejectionReason}</Alert>}
                  {cr.status === 'pending_review' && (
                    <div className="mt-3 flex gap-2">
                      <ReasonAction label="Approve" title="Approve creative" path={`/admin/creatives/${cr.id}/approve`} variant="primary" requireReason={false} onDone={res.reload} />
                      <ReasonAction label="Reject" title="Reject creative" path={`/admin/creatives/${cr.id}/reject`} danger onDone={res.reload} description="The advertiser sees this reason." />
                    </div>
                  )}
                </Card>
              ))}
            </div>
            <Pagination page={meta.page} pageSize={meta.pageSize} total={meta.total} onPage={setPage} />
          </>
        )}
      </Async>
    </>
  );
}
