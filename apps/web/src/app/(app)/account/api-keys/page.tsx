'use client';
import { useState, type FormEvent } from 'react';
import { Alert, Async, Badge, Button, Card, CardHeader, Checkbox, CodeBlock, Field, Input, Modal, PageHeader, Table } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { useOrg } from '@/lib/session';
import { del, errorMessage, post } from '@/lib/api';
import { formatDate, timeAgo } from '@/lib/format';

const SCOPES: Record<string, Array<[string, string]>> = {
  publisher: [['site:read', 'Read site status'], ['report:read', 'Read reports and stats'], ['unit:read', 'Read placements']],
  advertiser: [['campaign:read', 'Read campaigns'], ['report:read', 'Read reports'], ['billing:read', 'Read billing']],
};

export default function ApiKeys() {
  const org = useOrg();
  const res = useApi<{ data: any[] }>(`/orgs/${org.id}/api-keys`);
  const [create, setCreate] = useState<{ name: string; scopes: string[]; expiresInDays: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const available = SCOPES[org.type] ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await post<{ data: { key: string } }>(`/orgs/${org.id}/api-keys`, { name: create!.name, scopes: create!.scopes, expiresInDays: create!.expiresInDays ? Number(create!.expiresInDays) : undefined });
      setCreate(null);
      setSecret(r.data.key);
      res.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <>
      <PageHeader title="API keys" description="Server-to-server keys for reading your data. Keep them on your server; never put them in web pages or apps." actions={<Button onClick={() => setCreate({ name: '', scopes: [available[0]?.[0] ?? 'report:read'], expiresInDays: '365' })}>Create key</Button>} />
      {error && !create && <Alert tone="danger" className="mb-4">{error}</Alert>}
      {secret && (
        <Alert tone="warning" title="Copy this key now" className="mb-4">
          <p className="mb-2">It is shown only once. We store only a hash.</p>
          <CodeBlock code={secret} />
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => setSecret(null)}>I stored it</Button>
        </Alert>
      )}
      <Card>
        <Async res={res}>
          {({ data }) => <Table rows={data} rowKey={(r) => r.id} empty="No API keys." columns={[
            { key: 'n', header: 'Name', cell: (r) => <span className="font-medium">{r.name}</span> },
            { key: 'p', header: 'Key', cell: (r) => <code className="text-xs">{r.prefix}…</code> },
            { key: 's', header: 'Scopes', cell: (r) => <span className="flex flex-wrap gap-1">{r.scopes.map((s: string) => <Badge key={s}>{s}</Badge>)}</span> },
            { key: 'u', header: 'Last used', cell: (r) => (r.last_used_at ? timeAgo(r.last_used_at) : 'Never') },
            { key: 'e', header: 'Expires', cell: (r) => (r.revoked_at ? <Badge tone="danger">Revoked</Badge> : r.expires_at ? formatDate(r.expires_at) : 'Never') },
            { key: 'a', header: '', cell: (r) => !r.revoked_at && (
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={async () => { try { const x = await post<{ data: { key: string } }>(`/orgs/${org.id}/api-keys/${r.id}/rotate`); setSecret(x.data.key); res.reload(); } catch (e) { setError(errorMessage(e)); } }}>Rotate</Button>
                <Button size="sm" variant="ghost" onClick={async () => { if (!confirm('Revoke this key? Integrations using it stop working immediately.')) return; try { await del(`/orgs/${org.id}/api-keys/${r.id}`); res.reload(); } catch (e) { setError(errorMessage(e)); } }}>Revoke</Button>
              </span>
            ) },
          ]} />}
        </Async>
      </Card>
      <Modal open={!!create} onClose={() => setCreate(null)} title="Create API key" footer={<Button type="submit" form="key">Create</Button>}>
        {create && (
          <form id="key" onSubmit={submit} className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Name" htmlFor="kn" required><Input id="kn" required value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} placeholder="Reporting script" /></Field>
            <fieldset><legend className="mb-2 text-sm font-medium">Scopes</legend><div className="space-y-2">{available.map(([s, l]) => <Checkbox key={s} label={l} hint={s} checked={create.scopes.includes(s)} onChange={(v) => setCreate({ ...create, scopes: v ? [...create.scopes, s] : create.scopes.filter((x) => x !== s) })} />)}</div></fieldset>
            <Field label="Expires after (days)" htmlFor="kx" hint="Leave empty for no expiry. Shorter is safer."><Input id="kx" type="number" min={1} max={730} value={create.expiresInDays} onChange={(e) => setCreate({ ...create, expiresInDays: e.target.value })} /></Field>
          </form>
        )}
      </Modal>
    </>
  );
}
