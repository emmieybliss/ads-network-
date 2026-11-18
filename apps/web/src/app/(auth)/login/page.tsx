'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button, Checkbox, ErrorNotice, Field, Input } from '@/components/ui';
import { post } from '@/lib/api';
import { AuthCard, landingPath } from '../AuthCard';

function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [backupCode, setBackupCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
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
            const second = !mfa ? {} : useBackup ? { backupCode, trustDevice } : { totp, trustDevice };
            const r = await post<{ user?: any; mfaRequired?: boolean; backupCodesLeft?: number }>('/auth/login', { email, password, ...second });
            if (r.mfaRequired) {
              setMfa(true);
              return;
            }
            // A full navigation so the app loads with the new session cookie. Few backup codes left: show where to make new ones.
            window.location.href = r.backupCodesLeft !== undefined && r.backupCodesLeft <= 3 ? '/account/security?codes=low' : landingPath(r.user, params.get('next'));
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
          <>
            <div className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-fg-2">2-step verification is on for <span className="font-medium text-fg">{email}</span>.</div>
            {useBackup ? (
              <Field label="Backup code" hint="One of the 8-character codes you saved when you turned on 2-step verification. Each code works once." htmlFor="backup">
                <Input id="backup" autoComplete="one-time-code" autoFocus required maxLength={20} placeholder="xxxx-xxxx" value={backupCode} onChange={(e) => setBackupCode(e.target.value)} />
              </Field>
            ) : (
              <Field label="Authentication code" hint="Open your authenticator app and enter the 6-digit code for this account." htmlFor="totp">
                <Input id="totp" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} autoFocus required value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} className="text-center font-mono text-lg tracking-[0.4em]" />
              </Field>
            )}
            <Checkbox label="Don't ask again on this device" hint="For 30 days. Only on a computer or phone you use yourself." checked={trustDevice} onChange={setTrustDevice} />
            <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={() => { setUseBackup(!useBackup); setErr(null); }}>
              {useBackup ? 'Use your authenticator app instead' : 'Use a backup code instead'}
            </button>
          </>
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
