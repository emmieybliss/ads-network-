'use client';
import { useEffect, useState } from 'react';
import { Globe2, Megaphone } from 'lucide-react';
import { Alert, Button, ErrorNotice, Field, Input, Loading, cn } from '@/components/ui';
import { ApiError, get, post } from '@/lib/api';
import { AuthCard } from '../AuthCard';

interface MeLite { name: string; email: string; emailVerified: boolean; organizations: Array<{ id: string; type: string }> }

export default function OnboardingPage() {
  const [me, setMe] = useState<MeLite | null | undefined>(undefined);
  const [type, setType] = useState<'advertiser' | 'publisher'>('advertiser');
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    get<{ user: MeLite }>('/auth/me').then((r) => setMe(r.user)).catch((e) => {
      if (e instanceof ApiError && e.status === 401) window.location.href = '/login?next=/onboarding';
      else setErr(e);
    });
  }, []);

  if (me === undefined) return <AuthCard title="Set up your account"><Loading />{err ? <ErrorNotice error={err} /> : null}</AuthCard>;
  if (!me) return null;

  return (
    <AuthCard title="Set up your organization" subtitle="Advertisers and publishers work inside an organization, which can have several team members.">
      {!me.emailVerified && (
        <Alert tone="warning" title="Verify your email first" className="mb-4">
          We sent a link to {me.email}.{' '}
          {resent ? 'A new link is on its way.' : <button className="font-medium underline" onClick={async () => { await post('/auth/resend-verification').catch(() => undefined); setResent(true); }}>Send it again</button>}
        </Alert>
      )}
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const r = await post<{ data: { id: string } }>('/orgs', { name, type, country: country || undefined });
            try {
              window.localStorage.setItem('bn_current_org', r.data.id);
            } catch {
              /* ignore */
            }
            window.location.href = type === 'advertiser' ? '/advertiser' : '/publisher';
          } catch (x) {
            setErr(x);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          {([['advertiser', Megaphone, 'Advertiser'], ['publisher', Globe2, 'Publisher']] as const).map(([v, Icon, label]) => (
            <button type="button" key={v} onClick={() => setType(v)} aria-pressed={type === v} className={cn('flex items-center gap-2 rounded-xl border p-3 text-sm font-medium', type === v ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:bg-surface-2')}>
              <Icon className="size-4" aria-hidden /> {label}
            </button>
          ))}
        </div>
        <Field label="Organization name" htmlFor="name"><Input id="name" required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Country" hint="Two-letter code, for example US or GB. Optional." htmlFor="country"><Input id="country" maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} /></Field>
        <ErrorNotice error={err} />
        <Button type="submit" className="w-full" loading={busy} disabled={!me.emailVerified || !name.trim()}>Create organization</Button>
        <p className="text-xs text-muted">New organizations are reviewed by the network team before they can serve or buy ads.</p>
      </form>
    </AuthCard>
  );
}
