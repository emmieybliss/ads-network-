'use client';
import { useParams } from 'next/navigation';
import { Async, Button, Card, PageHeader, StatusBadge } from '@/components/ui';
import { SupportThread } from '@/components/SupportThread';
import { useApi } from '@/lib/hooks';
import { useOrg } from '@/lib/session';
import { post } from '@/lib/api';
import { humanize } from '@/lib/format';

export default function SupportCase() {
  const org = useOrg();
  const { id } = useParams<{ id: string }>();
  const res = useApi<{ data: any }>(`/orgs/${org.id}/support-cases/${id}`);
  return (
    <Async res={res}>
      {({ data }) => (
        <>
          <PageHeader back={{ href: '/support', label: 'Support' }} title={data.subject} description={<span className="flex items-center gap-2">{humanize(data.category)} <StatusBadge status={data.status} /></span>}
            actions={data.status !== 'closed' && <Button variant="secondary" onClick={async () => { await post(`/orgs/${org.id}/support-cases/${id}/close`); res.reload(); }}>Close request</Button>} />
          <Card><SupportThread messages={data.messages} closed={data.status === 'closed'} onSend={async (body) => { await post(`/orgs/${org.id}/support-cases/${id}/messages`, { body }); res.reload(); }} /></Card>
        </>
      )}
    </Async>
  );
}
