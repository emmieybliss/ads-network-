'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Async, Card, CardHeader, DefinitionList, Field, PageHeader, Select, StatusBadge } from '@/components/ui';
import { SupportThread } from '@/components/SupportThread';
import { useApi } from '@/lib/hooks';
import { patch, post } from '@/lib/api';
import { formatDate, humanize } from '@/lib/format';

export default function AdminSupportCase() {
  const { id } = useParams<{ id: string }>();
  const res = useApi<{ data: any }>(`/admin/support-cases/${id}`);
  const set = async (body: Record<string, unknown>) => { await patch(`/admin/support-cases/${id}`, body); res.reload(); };
  return (
    <Async res={res}>
      {({ data: c }) => (
        <>
          <PageHeader back={{ href: '/admin/support', label: 'Support' }} title={c.subject} description={<span className="flex items-center gap-2">{humanize(c.category)} <StatusBadge status={c.status} /></span>} />
          <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
            <Card><SupportThread staff messages={c.messages} onSend={async (body, internal) => { await post(`/admin/support-cases/${id}/messages`, { body, internal }); res.reload(); }} /></Card>
            <Card>
              <CardHeader title="Request" />
              <DefinitionList items={[['Organization', c.orgId ? <Link key="o" className="text-primary hover:underline" href={`/admin/orgs/${c.orgId}`}>{c.orgName}</Link> : '—'], ['Opened by', c.openedBy ?? '—'], ['Created', formatDate(c.createdAt, true)]]} />
              <div className="mt-4 space-y-3">
                <Field label="Status" htmlFor="cs"><Select id="cs" value={c.status} onChange={(e) => void set({ status: e.target.value })}>{['open', 'waiting_on_customer', 'waiting_on_staff', 'resolved', 'closed'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
                <Field label="Priority" htmlFor="cp"><Select id="cp" value={c.priority} onChange={(e) => void set({ priority: e.target.value })}>{['low', 'normal', 'high', 'urgent'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
              </div>
            </Card>
          </div>
        </>
      )}
    </Async>
  );
}
