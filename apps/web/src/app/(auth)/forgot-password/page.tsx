'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, ErrorNotice, Field, Input } from '@/components/ui';
import { post } from '@/lib/api';
import { AuthCard } from '../AuthCard';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <AuthCard title="Reset your password" footer={<Link href="/login" className="text-primary hover:underline">Back to sign in</Link>}>
      {done ? (
        <Alert tone="success" title="Check your email">If an account exists for {email}, we sent a link to reset the password. It is valid for one hour.</Alert>
      ) : (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              await post('/auth/password-reset/request', { email });
              setDone(true);
            } catch (x) {
              setErr(x);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Email" htmlFor="email"><Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <ErrorNotice error={err} />
          <Button type="submit" className="w-full" loading={busy}>Send reset link</Button>
        </form>
      )}
    </AuthCard>
  );
}
