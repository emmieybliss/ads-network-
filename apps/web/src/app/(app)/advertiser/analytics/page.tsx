'use client';
import { useState } from 'react';
import { Field, PageHeader, Select } from '@/components/ui';
import { AnalyticsDashboard } from '@/components/analytics/AnalyticsDashboard';
import { useApi } from '@/lib/hooks';
import { useOrg } from '@/lib/session';

export default function AdvertiserAnalytics() {
  const org = useOrg();
  const [campaignId, setCampaignId] = useState('');
  const camps = useApi<{ data: Array<{ id: string; name: string }> }>(`/orgs/${org.id}/campaigns?pageSize=100`);
  return (
    <>
      <PageHeader title="Analytics" description="Real time, trends, audiences, placements, conversions, CPA, ROAS and reach for your campaigns. Every number comes from validated events." actions={
        <Field label="Campaign" htmlFor="camp">
          <Select id="camp" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className="min-w-[220px]">
            <option value="">All campaigns</option>
            {camps.data?.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      } />
      <AnalyticsDashboard basePath={`/orgs/${org.id}/analytics`} exportPath={`/orgs/${org.id}/reports/export`} reportEmailPath={`/orgs/${org.id}/report-email`} audience="advertiser" currency={org.currency} filters={{ campaignId: campaignId || undefined }} />
    </>
  );
}
