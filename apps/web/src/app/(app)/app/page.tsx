'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loading } from '@/components/ui';
import { useSession } from '@/lib/session';

/** Sends a signed-in person to the right place. */
export default function AppHome() {
  const { me, org, loading } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (loading) return;
    if (!me) return router.replace('/login');
    if (org) return router.replace(org.type === 'advertiser' ? '/advertiser' : '/publisher');
    if (me.platformRole) return router.replace('/admin');
    router.replace('/onboarding');
  }, [loading, me, org, router]);
  return <Loading label="Opening your workspace…" />;
}
