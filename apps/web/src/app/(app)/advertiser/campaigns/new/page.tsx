'use client';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { CampaignForm } from '@/components/advertiser/CampaignForm';
import { post } from '@/lib/api';
import { useOrg } from '@/lib/session';

export default function NewCampaign() {
  const org = useOrg();
  const router = useRouter();
  return (
    <>
      <PageHeader title="New campaign" description="Campaigns start as drafts. Add creatives, then submit for review." back={{ href: '/advertiser/campaigns', label: 'Campaigns' }} />
      <CampaignForm submitLabel="Create draft" onSubmit={async (p) => {
        const r = await post<{ data: { id: string } }>(`/orgs/${org.id}/campaigns`, p);
        router.push(`/advertiser/campaigns/${r.data.id}?tab=creatives`);
      }} />
    </>
  );
}
