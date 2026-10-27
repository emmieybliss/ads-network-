'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, ErrorNotice, Field, Input } from '@/components/ui';
import { post } from '@/lib/api';
import { AuthCard } from '../AuthCard';

function Reset() {
  const token = useSearchParams().get('token') ?? '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <AuthCard title="Choose a new password">
      {done ? (
        <Alert tone="success" title="Password changed">All existing sessions were signed out. <Link href="/login" className="font-medium underline">Sign in</Link> with your new password.</Alert>
      ) : (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (pw !== pw2) return setErr(new Error('The passwords do not match'));
            setBusy(true);
            setErr(null);
            try {
              await post('/auth/password-reset/confirm', { token, password: pw });
              setDone(true);
            } catch (x) {
              setErr(x);
            } finally {
              setBusy(false);
            }
          }}
        >
          {!token && <Alert tone="danger">This link is missing its token. Request a new one.</Alert>}
          <Field label="New password" hint="At least 12 characters." htmlFor="pw"><Input id="pw" type="password" autoComplete="new-password" minLength={12} required value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <Field label="Repeat it" htmlFor="pw2"><Input id="pw2" type="password" autoComplete="new-password" minLength={12} required value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
          <ErrorNotice error={err} />
          <Button type="submit" className="w-full" loading={busy} disabled={!token}>Change password</Button>
        </form>
      )}
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return <Suspense><Reset /></Suspense>;
}
