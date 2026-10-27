'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Alert, Loading } from '@/components/ui';
import { errorMessage, post } from '@/lib/api';
import { AuthCard } from '../AuthCard';

function Verify() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState<'working' | 'ok' | 'error'>('working');
  const [msg, setMsg] = useState('');
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    if (!token) {
      setState('error');
      setMsg('This link is missing its token.');
      return;
    }
    post('/auth/verify-email', { token }).then(() => setState('ok')).catch((e) => {
      setState('error');
      setMsg(errorMessage(e));
    });
  }, [token]);
  return (
    <AuthCard title="Verify your email">
      {state === 'working' && <Loading label="Verifying…" />}
      {state === 'ok' && <Alert tone="success" title="Email verified">You can now <Link href="/login" className="font-medium underline">sign in</Link>.</Alert>}
      {state === 'error' && <Alert tone="danger" title="We could not verify this link">{msg} Links expire after 24 hours and work once. Sign in to request a new one.</Alert>}
    </AuthCard>
  );
}

export default function VerifyEmailPage() {
  return <Suspense><Verify /></Suspense>;
}
