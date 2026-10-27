'use client';
import { useState, type FormEvent } from 'react';
import { Alert, Async, Badge, Button, Card, CardHeader, CodeBlock, Field, Input, PageHeader, Table } from '@/components/ui';
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

function MfaCard() {
  const { me, refresh } = useSession();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'success', text: ok });
      setCode('');
      await refresh();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorMessage(e) });
    }
  };
  return (
    <Card>
      <CardHeader title="Two-step verification" description="Use an authenticator app for a 6-digit code at sign-in. Required for some staff roles." actions={me?.mfaEnabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>} />
      {msg && <Alert tone={msg.tone} className="mb-4">{msg.text}</Alert>}
      {me?.mfaEnabled ? (
        <form onSubmit={(e) => { e.preventDefault(); void run(() => post('/auth/mfa/disable', { code }), 'Two-step verification turned off.'); }} className="flex flex-wrap items-end gap-3">
          <Field label="Current code" htmlFor="dc"><Input id="dc" inputMode="numeric" pattern="\d{6}" required value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Button type="submit" variant="secondary">Turn off</Button>
        </form>
      ) : setup ? (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await post('/auth/mfa/enable', { code }); setSetup(null); }, 'Two-step verification is on.'); }} className="space-y-4">
          <p className="text-sm text-fg-2">Add this key to your authenticator app (or open the setup link on your phone), then enter the code it shows.</p>
          <CodeBlock label="Setup key" code={setup.secret} />
          <a className="text-sm text-primary underline" href={setup.otpauthUrl}>Open in authenticator app</a>
          <Field label="Code from the app" htmlFor="ec"><Input id="ec" inputMode="numeric" pattern="\d{6}" required value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Button type="submit">Turn on</Button>
        </form>
      ) : (
        <Button onClick={async () => { try { setSetup(await post('/auth/mfa/setup')); } catch (e) { setMsg({ tone: 'danger', text: errorMessage(e) }); } }}>Set up</Button>
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

export default function Security() {
  return (
    <>
      <PageHeader title="Sign-in & security" />
      <div className="grid gap-5 lg:grid-cols-2">
        <PasswordCard />
        <MfaCard />
      </div>
      <div className="mt-5"><Sessions /></div>
    </>
  );
}
