'use client';
import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button, Input, PageHeader } from '@/components/ui';
import { AdminTable } from '@/components/admin/kit';
import { get, qs } from '@/lib/api';
import { formatDate } from '@/lib/format';

export default function Audit() {
  const [action, setAction] = useState('');
  const [resourceType, setResourceType] = useState('');
  const filters = { action: action || undefined, resourceType: resourceType || undefined };
  return (
    <>
      <PageHeader title="Audit log" description="Append-only record of sensitive actions: who, what, when and why. Entries cannot be edited or deleted." actions={
        <Button variant="secondary" onClick={async () => {
          // Fetched through the API client so the password confirmation prompt can run first.
          try {
            const csv = await get<string>(`/admin/audit/export${qs(filters)}`);
            const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
            Object.assign(document.createElement('a'), { href: url, download: 'audit-log.csv' }).click();
            URL.revokeObjectURL(url);
          } catch { /* cancelled or failed; the table remains */ }
        }}><Download className="size-4" /> Export CSV</Button>
      } />
      <AdminTable<any> path="/admin/audit" search={false} extra={filters} rowKey={(r) => String(r.id)}
        toolbar={<>
          <Input aria-label="Action" placeholder="Action, for example site.approve" value={action} onChange={(e) => setAction(e.target.value)} className="max-w-xs" />
          <Input aria-label="Resource type" placeholder="Resource type, for example campaign" value={resourceType} onChange={(e) => setResourceType(e.target.value)} className="max-w-xs" />
        </>}
        columns={[
          { key: 'w', header: 'When', cell: (r) => formatDate(r.created_at, true) },
          { key: 'a', header: 'Actor', cell: (r) => r.actor_email ?? r.actor_type },
          { key: 'c', header: 'Action', cell: (r) => <code className="text-xs">{r.action}</code> },
          { key: 'r', header: 'Resource', cell: (r) => <span className="text-xs">{r.resource_type} {r.resource_id ? <code>{String(r.resource_id).slice(0, 8)}</code> : ''}</span> },
          { key: 'y', header: 'Reason', cell: (r) => <span className="text-sm">{r.reason ?? ''}</span> },
          { key: 'd', header: 'Change', cell: (r) => (r.before || r.after ? <details><summary className="cursor-pointer text-xs text-primary">View</summary><pre className="max-w-md overflow-x-auto text-[11px]">{JSON.stringify({ before: r.before, after: r.after }, null, 2)}</pre></details> : '') },
        ]} />
    </>
  );
}
