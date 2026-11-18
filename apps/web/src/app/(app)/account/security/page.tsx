'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Async, Badge, Button, Card, CardHeader, Field, Input, PageHeader, Table } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { del, errorMessage, post } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';

function PasswordCard() {
  const [f, setF] = useState({ currentPassword: '', newPassword: '' });
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await post('/auth/password', f);
      setF({ currentPassword: '', newPassword: '' });
      setMsg({ tone: 'success', text: 'Password changed. Other sessions were signed out.' });
    } catch (err) {
      setMsg({ tone: 'danger', text: errorMessage(err) });
    }
  }
  return (
    <Card>
      <CardHeader title="Password" />
      <form onSubmit={submit} className="space-y-4">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Field label="Current password" htmlFor="cp"><Input id="cp" type="password" autoComplete="current-password" required value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} /></Field>
        <Field label="New password" htmlFor="np" hint="At least 12 characters. Common and breached passwords are refused."><Input id="np" type="password" autoComplete="new-password" required minLength={12} value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} /></Field>
        <Button type="submit">Change password</Button>
      </form>
    </Card>
  );
}

interface MfaStatus {
  enabled: boolean;
  enabledAt: string | null;
  required: boolean;
  backupCodesLeft: number;
  trustedDevices: Array<{ id: string; userAgent: string | null; createdAt: string; lastUsedAt: string; expiresAt: string; current: boolean }>;
}

function deviceName(ua: string | null) {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** The ten one-time codes, shown once, with copy and download. */
function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = `Backup codes for your account (each works once)\n\n${codes.join('\n')}\n`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-4" data-testid="backup-codes">
      <Alert tone="warning" title="Save these backup codes now">They let you sign in if you lose your phone. Each code works once. This is the only time they are shown.</Alert>
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-xl border border-border bg-surface-2 p-4 font-mono text-[15px] text-fg">
        {codes.map((c, i) => <li key={c} className="flex gap-2"><span className="w-5 text-right text-xs leading-6 text-muted">{i + 1}.</span>{c}</li>)}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* clipboard blocked */ } }}>{copied ? 'Copied' : 'Copy'}</Button>
        <Button variant="secondary" size="sm" onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = 'backup-codes.txt'; a.click(); }}>Download .txt</Button>
        <Button size="sm" onClick={onDone}>I have saved them</Button>
      </div>
    </div>
  );
}

function MfaCard() {
  const { me, refresh } = useSession();
  const status = useApi<{ data: MfaStatus }>('/auth/mfa');
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string; qrSvg: string } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const st = status.data?.data;
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    setBusy(true);
    try {
      await fn();
      if (ok) setMsg({ tone: 'success', text: ok });
      setCode('');
      await refresh();
      status.reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const on = me?.mfaEnabled;
  return (
    <Card>
      <CardHeader title="2-step verification" description="A second step after your password: a 6-digit code from an authenticator app such as Google Authenticator, Microsoft Authenticator, 1Password or Authy." actions={on ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>} />
      {msg && <Alert tone={msg.tone} className="mb-4">{msg.text}</Alert>}
      {codes ? (
        <BackupCodes codes={codes} onDone={() => setCodes(null)} />
      ) : on ? (
        <div className="space-y-5">
          <p className="text-sm text-fg-2">{st?.enabledAt ? `On since ${formatDate(st.enabledAt)}. ` : ''}Signing in asks for a code from your app, unless you chose not to be asked again on that device.</p>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3">
            <div>
              <div className="text-sm font-medium text-fg">Backup codes</div>
              <div className={st && st.backupCodesLeft <= 3 ? 'text-sm text-warning' : 'text-sm text-muted'}>{st ? `${st.backupCodesLeft} of 10 left` : '…'}</div>
            </div>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void run(async () => setCodes((await post<{ backupCodes: string[] }>('/auth/mfa/backup-codes')).backupCodes))}>Get new codes</Button>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-fg">Devices that don't ask for a code</div>
              {st && st.trustedDevices.length > 0 && <Button size="sm" variant="ghost" onClick={() => void run(() => post('/auth/mfa/trusted-devices/revoke-all'), 'Every device will ask for a code at the next sign-in.')}>Revoke all</Button>}
            </div>
            {!st || st.trustedDevices.length === 0 ? <p className="text-sm text-muted">None. Tick “Don't ask again on this device” when you sign in to add one.</p> : (
              <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                {st.trustedDevices.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span>{deviceName(d.userAgent)}{d.current && <Badge tone="success" className="ml-2">This device</Badge>}<span className="block text-xs text-muted">Last used {timeAgo(d.lastUsedAt)} · until {formatDate(d.expiresAt)}</span></span>
                    <Button size="sm" variant="ghost" onClick={() => void run(() => del(`/auth/mfa/trusted-devices/${d.id}`))}>Revoke</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {st?.required ? (
            <p className="text-xs text-muted">This network requires 2-step verification, so it cannot be turned off. Lost your phone? Use a backup code, or ask support to reset it.</p>
          ) : (
            <Button variant="secondary" loading={busy} onClick={() => void run(() => post('/auth/mfa/disable'), '2-step verification is off.')}>Turn off</Button>
          )}
        </div>
      ) : setup ? (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await post<{ backupCodes: string[] }>('/auth/mfa/enable', { code }); setSetup(null); setCodes(r.backupCodes); }, '2-step verification is on.'); }} className="space-y-5" data-testid="mfa-setup">
          <div className="grid gap-5 sm:grid-cols-[180px_minmax(0,1fr)]">
            <img src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`} alt="QR code to scan with your authenticator app" width={180} height={180} className="rounded-lg border border-border bg-white p-1.5" />
            <ol className="list-decimal space-y-2 pl-5 text-sm text-fg-2">
              <li>Open your authenticator app and add an account.</li>
              <li>Scan this QR code. <button type="button" className="font-medium text-primary hover:underline" onClick={() => setShowKey(!showKey)}>Can't scan it?</button>
                {showKey && <div className="mt-2"><div className="rounded-lg border border-border bg-surface-2 px-3 py-2"><div className="text-xs text-muted">Enter this key (time-based)</div><code className="block select-all break-words font-mono text-sm text-fg">{setup.secret.match(/.{1,4}/g)!.join(' ')}</code></div><a className="mt-1 inline-block text-xs text-primary underline" href={setup.otpauthUrl}>Open in an authenticator app on this device</a></div>}
              </li>
              <li>Enter the 6-digit code the app shows.</li>
            </ol>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Code from the app" htmlFor="ec"><Input id="ec" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="w-40 text-center font-mono tracking-[0.3em]" /></Field>
            <Button type="submit" loading={busy}>Turn on</Button>
            <Button variant="ghost" onClick={() => setSetup(null)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-fg-2">With 2-step verification on, someone who learns your password still cannot sign in without your phone. You also get ten backup codes for when the phone is not at hand.</p>
          <Button loading={busy} onClick={async () => { setBusy(true); try { setSetup(await post('/auth/mfa/setup')); } catch (e) { setMsg({ tone: 'danger', text: errorMessage(e) }); } finally { setBusy(false); } }}>Get started</Button>
        </div>
      )}
    </Card>
  );
}

function Sessions() {
  const res = useApi<{ data: Array<{ id: string; userAgent: string | null; createdAt: string; lastSeenAt: string; expiresAt: string; current: boolean }> }>('/auth/sessions');
  return (
    <Card>
      <CardHeader title="Signed-in sessions" actions={<Button size="sm" variant="secondary" onClick={async () => { await post('/auth/sessions/revoke-others'); res.reload(); }}>Sign out other sessions</Button>} />
      <Async res={res}>
        {({ data }) => <Table rows={data} rowKey={(r) => r.id} columns={[
          { key: 'd', header: 'Device', cell: (r) => <span className="line-clamp-1 text-sm">{r.userAgent ?? 'Unknown'}{r.current && <Badge tone="success" className="ml-2">This session</Badge>}</span> },
          { key: 's', header: 'Signed in', cell: (r) => formatDate(r.createdAt) },
          { key: 'l', header: 'Last active', cell: (r) => timeAgo(r.lastSeenAt) },
          { key: 'x', header: '', cell: (r) => !r.current && <Button size="sm" variant="ghost" onClick={async () => { await del(`/auth/sessions/${r.id}`); res.reload(); }}>Sign out</Button> },
        ]} />}
      </Async>
    </Card>
  );
}

function RequiredNotice() {
  const { me } = useSession();
  const [why, setWhy] = useState<string | null>(null);
  useEffect(() => { setWhy(new URLSearchParams(window.location.search).get('setup') ?? new URLSearchParams(window.location.search).get('codes')); }, []);
  if (me?.mfaRequired && !me.mfaEnabled) return <Alert tone="warning" title="Turn on 2-step verification to continue" className="mb-5">This network requires 2-step verification for every account. Set it up below; it takes about a minute with an authenticator app on your phone.</Alert>;
  if (why === 'low' && me?.mfaEnabled) return <Alert tone="warning" title="You are running low on backup codes" className="mb-5">Get new codes below and keep them somewhere safe.</Alert>;
  return null;
}

export default function Security() {
  return (
    <>
      <PageHeader title="Sign-in & security" />
      <RequiredNotice />
      <div className="grid gap-5 lg:grid-cols-2">
        <PasswordCard />
        <MfaCard />
      </div>
      <div className="mt-5"><Sessions /></div>
    </>
  );
}
