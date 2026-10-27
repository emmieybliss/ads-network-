'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, ErrorNotice } from '@/components/ui';
import { ApiError, post } from '@/lib/api';
import { AuthCard } from '../../AuthCard';

function Accept() {
  const token = useSearchParams().get('token') ?? '';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const needsLogin = err instanceof ApiError && err.status === 401;
  const next = `/invitations/accept?token=${encodeURIComponent(token)}`;
  return (
    <AuthCard title="Join a team" subtitle="You were invited to an organization on the network.">
      {needsLogin ? (
        <Alert tone="info" title="Sign in first">
          Sign in (or create an account) with the email address the invitation was sent to, then come back to this link.
          <div className="mt-3 flex gap-3">
            <Link className="font-medium underline" href={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link>
            <Link className="font-medium underline" href="/register">Create an account</Link>
          </div>
        </Alert>
      ) : (
        <>
          <ErrorNotice error={err} />
          <Button
            className="mt-2 w-full"
            loading={busy}
            disabled={!token}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const r = await post<{ orgId: string }>('/invitations/accept', { token });
                try {
                  window.localStorage.setItem('bn_current_org', r.orgId);
                } catch {
                  /* ignore */
                }
                window.location.href = '/app';
              } catch (x) {
                setErr(x);
              } finally {
                setBusy(false);
              }
            }}
          >
            Accept invitation
          </Button>
        </>
      )}
    </AuthCard>
  );
}

export default function AcceptInvitationPage() {
  return <Suspense><Accept /></Suspense>;
}
