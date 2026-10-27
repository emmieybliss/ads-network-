'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button, ErrorNotice, Field, Input } from '@/components/ui';
import { post } from '@/lib/api';
import { AuthCard, landingPath } from '../AuthCard';

function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [mfa, setMfa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  return (
    <AuthCard title="Sign in" subtitle="Welcome back." footer={<>New here? <Link href="/register" className="font-medium text-primary hover:underline">Create an account</Link></>}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const r = await post<{ user?: any; mfaRequired?: boolean }>('/auth/login', { email, password, totp: mfa ? totp : undefined });
            if (r.mfaRequired) {
              setMfa(true);
              return;
            }
            // A full navigation so the app loads with the new session cookie.
            window.location.href = landingPath(r.user, params.get('next'));
          } catch (x) {
            setErr(x);
          } finally {
            setBusy(false);
          }
        }}
      >
        {!mfa ? (
          <>
            <Field label="Email" htmlFor="email"><Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label={<span className="flex justify-between">Password <Link href="/forgot-password" className="text-xs font-normal text-primary hover:underline">Forgot password?</Link></span>} htmlFor="password">
              <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </>
        ) : (
          <Field label="Authentication code" hint="Enter the 6-digit code from your authenticator app." htmlFor="totp">
            <Input id="totp" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} autoFocus required value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} />
          </Field>
        )}
        <ErrorNotice error={err} />
        <Button type="submit" className="w-full" size="lg" loading={busy}>{mfa ? 'Verify' : 'Sign in'}</Button>
      </form>
    </AuthCard>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
