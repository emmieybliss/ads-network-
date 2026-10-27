'use client';
import { useState } from 'react';
import { PAYOUT_STATUSES } from '@blissnova/shared';
import { PageHeader, StatusBadge } from '@/components/ui';
import { AdminTable, ReasonAction } from '@/components/admin/kit';
import { useSession } from '@/lib/session';
import { post } from '@/lib/api';
import { formatDate, formatMicros } from '@/lib/format';

export default function Payouts() {
  const { canAdmin } = useSession();
  const [k, setK] = useState(0);
  const manage = canAdmin('admin:payouts:manage');
  const done = () => setK((x) => x + 1);
  return (
    <>
      <PageHeader title="Payouts" description="Requested → approved → processing → paid. Mark paid only with the bank or provider reference of a transfer that was actually sent." />
      <AdminTable<any> path="/admin/payouts" reloadKey={k} statuses={[...PAYOUT_STATUSES]} search={false} rowKey={(r) => r.id} columns={[
        { key: 'd', header: 'Requested', cell: (r) => formatDate(r.created_at) },
        { key: 'o', header: 'Publisher', cell: (r) => <div><p>{r.org_name}</p><p className="text-xs text-muted">by {r.requested_by_name}</p></div> },
        { key: 'a', header: 'Amount', align: 'right', cell: (r) => formatMicros(r.amount_micros, r.currency) },
        { key: 'm', header: 'Method', cell: (r) => r.method_label ?? '—' },
        { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
        { key: 'r', header: 'Reference / notes', cell: (r) => <span className="text-xs">{r.provider_ref ?? ''} {r.failure_reason ?? r.review_reason ?? ''}</span> },
        { key: 'x', header: '', cell: (r) => manage && (
          <span className="flex flex-wrap gap-1">
            {r.status === 'requested' && <ReasonAction label="Approve" title="Approve payout" path={`/admin/payouts/${r.id}/approve`} variant="primary" onDone={done} />}
            {r.status === 'requested' && <ReasonAction label="Reject" title="Reject payout" path={`/admin/payouts/${r.id}/reject`} danger onDone={done} description="Funds return to the publisher's available balance." />}
            {r.status === 'approved' && <ReasonAction label="Start processing" title="Mark payout as processing" path="" requireReason={false} onDone={done} run={() => post(`/admin/payouts/${r.id}/processing`, { provider: 'manual' })} />}
            {r.status === 'processing' && <ReasonAction label="Mark paid" title="Record payout as paid" path="" onDone={done} description="You will be asked for the transfer reference." run={async (reason) => { const ref = window.prompt('Bank or provider reference of the transfer'); if (!ref) throw new Error('A reference is required'); await post(`/admin/payouts/${r.id}/paid`, { providerRef: ref, reason }); }} />}
            {r.status === 'processing' && <ReasonAction label="Mark failed" title="Record payout failure" path={`/admin/payouts/${r.id}/failed`} danger onDone={done} description="Funds return to the publisher's available balance." />}
          </span>
        ) },
      ]} />
    </>
  );
}
