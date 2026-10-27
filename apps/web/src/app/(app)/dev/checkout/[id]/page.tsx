'use client';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { Alert, Button, Card } from '@/components/ui';
import { errorMessage, post } from '@/lib/api';

/**
 * Local development checkout for the simulated payment provider. Completing it
 * sends a signed webhook through the same path a real provider uses; the
 * balance changes only when that webhook is processed. The API does not offer
 * this provider in production.
 */
export default function DevCheckout() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function complete(outcome: 'succeeded' | 'failed') {
    setBusy(outcome);
    setError(null);
    try {
      await post(`/payments/dev/${id}/complete`, { outcome });
      router.push(`/advertiser/billing?payment=${id}&status=${outcome === 'succeeded' ? 'returned' : 'cancelled'}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }
  return (
    <Card className="w-full">
      <div className="mb-4 flex items-center gap-2 text-warning"><FlaskConical className="size-5" /><h1 className="text-lg font-semibold text-fg">Simulated checkout</h1></div>
      <Alert tone="warning" title="Development only">No real money moves. This page exists only for local testing and is unavailable in production.</Alert>
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
      <p className="mt-4 text-sm text-fg-2">Choose the outcome the simulated provider should report for payment <span className="font-mono text-xs">{id}</span>.</p>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button onClick={() => complete('succeeded')} loading={busy === 'succeeded'}>Simulate successful payment</Button>
        <Button variant="secondary" onClick={() => complete('failed')} loading={busy === 'failed'}>Simulate failed payment</Button>
        <Button variant="ghost" onClick={() => router.push(`/advertiser/billing?status=cancelled`)}>Cancel</Button>
      </div>
    </Card>
  );
}
