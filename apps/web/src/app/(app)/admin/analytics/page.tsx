'use client';
import { PageHeader } from '@/components/ui';
import { AnalyticsDashboard } from '@/components/analytics/AnalyticsDashboard';
import { useConfig } from '@/lib/hooks';

export default function AdminAnalytics() {
  const cfg = useConfig();
  return (
    <>
      <PageHeader title="Network analytics" description="The whole network: spend, publisher earnings and network revenue, audiences, traffic sources, sessions, conversions, viewability and invalid traffic." />
      <AnalyticsDashboard basePath="/admin/analytics" audience="admin" currency={cfg.data?.data.pricing.defaultCurrency ?? 'USD'} />
    </>
  );
}
