'use client';
import { useState } from 'react';
import { Field, PageHeader, Select } from '@/components/ui';
import { ReportExplorer } from '@/components/ReportExplorer';
import { useApi } from '@/lib/hooks';
import { useOrg } from '@/lib/session';

export default function PublisherReports() {
  const org = useOrg();
  const [siteId, setSiteId] = useState('');
  const sites = useApi<{ data: Array<{ id: string; name: string; domain: string }> }>(`/orgs/${org.id}/sites`);
  return (
    <>
      <PageHeader title="Reports" description="Requests, valid impressions, clicks and estimated earnings. Invalid traffic is shown separately and never earns." actions={
        <Field label="Website" htmlFor="site">
          <Select id="site" value={siteId} onChange={(e) => setSiteId(e.target.value)} className="min-w-[220px]">
            <option value="">All websites</option>
            {sites.data?.data.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.domain})</option>)}
          </Select>
        </Field>
      } />
      <ReportExplorer orgId={org.id} audience="publisher" currency={org.currency} filters={{ siteId: siteId || undefined }} />
    </>
  );
}
