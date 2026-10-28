'use client';
import { useState } from 'react';
import { Field, PageHeader, Select } from '@/components/ui';
import { ReportExplorer } from '@/components/ReportExplorer';
import { SourceReport } from '@/components/partners/PartnerPanels';
import { useApi } from '@/lib/hooks';
import { useOrg } from '@/lib/session';

export default function AdvertiserReports() {
  const org = useOrg();
  const [campaignId, setCampaignId] = useState('');
  const camps = useApi<{ data: Array<{ id: string; name: string }> }>(`/orgs/${org.id}/campaigns?pageSize=100`);
  return (
    <>
      <PageHeader title="Reports" description="Validated delivery and spend. CTR is valid clicks divided by valid impressions, multiplied by 100." actions={
        <Field label="Campaign" htmlFor="camp">
          <Select id="camp" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className="min-w-[220px]">
            <option value="">All campaigns</option>
            {camps.data?.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      } />
      <div className="mb-5"><SourceReport path={`/orgs/${org.id}/reports/sources${campaignId ? `?campaignId=${campaignId}` : ''}`} currency={org.currency} /></div>
      <ReportExplorer orgId={org.id} audience="advertiser" currency={org.currency} filters={{ campaignId: campaignId || undefined }} />
    </>
  );
}
