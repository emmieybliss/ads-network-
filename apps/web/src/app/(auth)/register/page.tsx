'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Megaphone, Globe2 } from 'lucide-react';
import { Alert, Button, ErrorNotice, Field, Input, cn } from '@/components/ui';
import { post } from '@/lib/api';
import { brand } from '@/lib/brand';
import { AuthCard } from '../AuthCard';

function RegisterForm() {
  const params = useSearchParams();
  const initial = params.get('type') === 'publisher' ? 'publisher' : params.get('type') === 'advertiser' ? 'advertiser' : null;
  const [type, setType] = useState<'advertiser' | 'publisher' | null>(initial);
  const [f, setF] = useState({ name: '', email: '', password: '', organizationName: '' });
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  if (done) {
    return (
      <AuthCard title="Check your email" subtitle={<>We sent a verification link to <strong>{f.email}</strong>.</>}>
        <p className="text-sm text-muted">Follow the link to verify your address, then sign in. The link is valid for 24 hours.</p>
        {process.env.NEXT_PUBLIC_DEMO_MODE === 'true' && (
          <Alert tone="info" title="Local demo" className="mt-4">Emails are not sent in local development. Open the local mail viewer (Mailpit at http://localhost:8025) or the API log to find the link.</Alert>
        )}
        <Link href="/login" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">Go to sign in</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Create your account" subtitle={`Join ${brand.productName}.`} footer={<>Already have an account? <Link href="/login" className="font-medium text-primary hover:underline">Sign in</Link></>}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await post('/auth/register', { name: f.name, email: f.email, password: f.password, accountType: type ?? undefined, organizationName: f.organizationName || undefined });
            setDone(true);
          } catch (x) {
            setErr(x);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">I want to</legend>
          <div className="grid grid-cols-2 gap-2">
            {([['advertiser', Megaphone, 'Advertise'], ['publisher', Globe2, 'Monetize a site']] as const).map(([v, Icon, label]) => (
              <button type="button" key={v} onClick={() => setType(v)} aria-pressed={type === v} className={cn('flex items-center gap-2 rounded-xl border p-3 text-left text-sm font-medium transition-colors', type === v ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:bg-surface-2')}>
                <Icon className="size-4" aria-hidden /> {label}
              </button>
            ))}
          </div>
        </fieldset>
        <Field label="Your name" htmlFor="name"><Input id="name" autoComplete="name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Work email" htmlFor="email"><Input id="email" type="email" autoComplete="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Password" hint="At least 12 characters." htmlFor="password"><Input id="password" type="password" autoComplete="new-password" minLength={12} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        {type && (
          <Field label={type === 'advertiser' ? 'Company or brand name' : 'Publisher or site owner name'} hint="You can change this later." htmlFor="org">
            <Input id="org" value={f.organizationName} onChange={(e) => setF({ ...f, organizationName: e.target.value })} />
          </Field>
        )}
        <label className="flex items-start gap-2 text-sm text-fg-2">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>I agree to the <Link className="text-primary hover:underline" href={brand.legal.termsUrl}>terms</Link> and <Link className="text-primary hover:underline" href={brand.legal.privacyUrl}>privacy policy</Link>.</span>
        </label>
        <ErrorNotice error={err} />
        <Button type="submit" className="w-full" size="lg" loading={busy} disabled={!agree}>Create account</Button>
      </form>
    </AuthCard>
  );
}

export default function RegisterPage() {
  return <Suspense><RegisterForm /></Suspense>;
}
