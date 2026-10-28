'use client';
import { useState } from 'react';
import { Field, PageHeader, Select } from '@/components/ui';
import { AnalyticsDashboard } from '@/components/analytics/AnalyticsDashboard';
import { useApi } from '@/lib/hooks';
import { useOrg } from '@/lib/session';

export default function PublisherAnalytics() {
  const org = useOrg();
  const [siteId, setSiteId] = useState('');
  const sites = useApi<{ data: Array<{ id: string; name: string; domain: string }> }>(`/orgs/${org.id}/sites`);
  return (
    <>
      <PageHeader title="Analytics" description="Real time, trends, audiences, traffic sources, sessions, viewability and traffic quality for your websites. Every number comes from validated events." actions={
        <Field label="Website" htmlFor="site">
          <Select id="site" value={siteId} onChange={(e) => setSiteId(e.target.value)} className="min-w-[220px]">
            <option value="">All websites</option>
            {sites.data?.data.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.domain})</option>)}
          </Select>
        </Field>
      } />
      <AnalyticsDashboard basePath={`/orgs/${org.id}/analytics`} exportPath={`/orgs/${org.id}/reports/export`} reportEmailPath={`/orgs/${org.id}/report-email`} audience="publisher" currency={org.currency} filters={{ siteId: siteId || undefined }} />
    </>
  );
}
