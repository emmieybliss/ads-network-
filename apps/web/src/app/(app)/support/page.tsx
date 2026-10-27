'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Async, Button, Card, Field, Input, Modal, PageHeader, Select, StatusBadge, Table, Textarea } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { useOrg } from '@/lib/session';
import { errorMessage, post } from '@/lib/api';
import { humanize, timeAgo } from '@/lib/format';

const CATEGORIES = ['general', 'billing', 'payouts', 'verification', 'policy', 'technical', 'account'];

export default function Support() {
  const org = useOrg();
  const router = useRouter();
  const res = useApi<{ data: any[] }>(`/orgs/${org.id}/support-cases`);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ subject: '', category: 'general', body: '' });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await post<{ data: { id: string } }>(`/orgs/${org.id}/support-cases`, f);
      router.push(`/support/${r.data.id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <>
      <PageHeader title="Support" description="Questions about billing, payouts, verification, policy or your account. The team replies here and by email." actions={<Button onClick={() => setOpen(true)}>New request</Button>} />
      <Card>
        <Async res={res}>
          {({ data }) => <Table rows={data} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/support/${r.id}`)} empty="No support requests." columns={[
            { key: 's', header: 'Subject', cell: (r) => <span className="font-medium">{r.subject}</span> },
            { key: 'c', header: 'Category', cell: (r) => humanize(r.category) },
            { key: 'st', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            { key: 'u', header: 'Updated', cell: (r) => timeAgo(r.updatedAt) },
          ]} />}
        </Async>
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="New support request" wide footer={<Button type="submit" form="sc">Send</Button>}>
        <form id="sc" onSubmit={submit} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Subject" htmlFor="ss" required><Input id="ss" required minLength={3} maxLength={200} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
          <Field label="Category" htmlFor="sca"><Select id="sca" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select></Field>
          <Field label="How can we help?" htmlFor="sb" required hint="Never include passwords or full card or bank numbers."><Textarea id="sb" rows={6} required minLength={10} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        </form>
      </Modal>
    </>
  );
}
