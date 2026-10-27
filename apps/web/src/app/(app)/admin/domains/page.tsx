'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, PageHeader, Select, StatusBadge } from '@/components/ui';
import { AdminTable } from '@/components/admin/kit';
import { formatDate, humanize, timeAgo } from '@/lib/format';

export default function Domains() {
  const router = useRouter();
  const [verified, setVerified] = useState('');
  const [method, setMethod] = useState('');
  return (
    <>
      <PageHeader title="Domains" description="Every registered hostname, how its control was proven, and its check history." />
      <AdminTable<any> path="/admin/domains" extra={{ verified: verified || undefined, method: method || undefined }} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/admin/sites/${r.id}`)}
        toolbar={<>
          <Select aria-label="Verified" value={verified} onChange={(e) => setVerified(e.target.value)} className="max-w-[160px]"><option value="">Any</option><option value="yes">Verified</option><option value="no">Not verified</option></Select>
          <Select aria-label="Method" value={method} onChange={(e) => setMethod(e.target.value)} className="max-w-[180px]"><option value="">Any method</option>{['dns_txt', 'html_file', 'meta_tag', 'manual', 'simulated'].map((m) => <option key={m} value={m}>{humanize(m)}</option>)}</Select>
        </>}
        columns={[
          { key: 'd', header: 'Domain', cell: (r) => <div><p className="font-medium">{r.domain}</p>{r.allowed_domains?.length > 0 && <p className="text-xs text-muted">+ {r.allowed_domains.join(', ')}</p>}</div> },
          { key: 'o', header: 'Publisher', cell: (r) => r.org_name },
          { key: 's', header: 'Site status', cell: (r) => <StatusBadge status={r.status} /> },
          { key: 'v', header: 'Proof', cell: (r) => (r.verified_at ? <span className="flex gap-1">{humanize(r.verification_method)} · {r.verification_scope}{r.verification_simulated && <Badge tone="warning">Simulated</Badge>}</span> : <span className="text-muted">None</span>) },
          { key: 'va', header: 'Verified', cell: (r) => (r.verified_at ? formatDate(r.verified_at) : '—') },
          { key: 'a', header: 'Checks (failed)', align: 'right', cell: (r) => `${r.attempts} (${r.failed_attempts})` },
          { key: 'l', header: 'Last check', cell: (r) => (r.last_attempt_at ? timeAgo(r.last_attempt_at) : '—') },
        ]} />
    </>
  );
}
