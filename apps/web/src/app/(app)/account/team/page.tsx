'use client';
import { useState, type FormEvent } from 'react';
import { Alert, Async, Button, Card, CardHeader, Field, Input, PageHeader, Select, Table } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { useOrg, useSession } from '@/lib/session';
import { del, errorMessage, patch, post } from '@/lib/api';
import { formatDate, humanize } from '@/lib/format';

const ROLES = ['owner', 'manager', 'analyst'];
const ROLE_HELP = 'Owners manage everything including team and billing. Managers run campaigns or sites. Analysts can view reports only.';

export default function Team() {
  const org = useOrg();
  const { me, can } = useSession();
  const manage = can('org:members:manage');
  const members = useApi<{ data: any[] }>(`/orgs/${org.id}/members`);
  const invites = useApi<{ data: any[] }>(manage ? `/orgs/${org.id}/invitations` : null);
  const [inv, setInv] = useState({ email: '', role: 'analyst' });
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ tone: 'success', text: ok });
      members.reload();
      invites.reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorMessage(e) });
    }
  };
  return (
    <>
      <PageHeader title="Team" description={ROLE_HELP} />
      {msg && <Alert tone={msg.tone} className="mb-4">{msg.text}</Alert>}
      <Card>
        <CardHeader title="Members" />
        <Async res={members}>
          {({ data }) => <Table rows={data} rowKey={(r) => r.userId} columns={[
            { key: 'n', header: 'Name', cell: (r) => <div><p className="font-medium">{r.name}{r.userId === me?.id && <span className="text-muted"> (you)</span>}</p><p className="text-xs text-muted">{r.email}</p></div> },
            { key: 'r', header: 'Role', cell: (r) => manage && r.userId !== me?.id ? (
              <Select aria-label="Role" value={r.role} onChange={(e) => run(() => patch(`/orgs/${org.id}/members/${r.userId}`, { role: e.target.value }), 'Role updated.')} className="w-36">{ROLES.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</Select>
            ) : humanize(r.role) },
            { key: 'j', header: 'Joined', cell: (r) => formatDate(r.joinedAt) },
            { key: 'x', header: '', cell: (r) => manage && r.userId !== me?.id && <Button size="sm" variant="ghost" onClick={() => confirm(`Remove ${r.name} from ${org.name}?`) && run(() => del(`/orgs/${org.id}/members/${r.userId}`), 'Member removed.')}>Remove</Button> },
          ]} />}
        </Async>
      </Card>
      {manage && (
        <Card className="mt-5">
          <CardHeader title="Invitations" description="Invitations expire after 7 days." />
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); void run(() => post(`/orgs/${org.id}/invitations`, inv), `Invitation sent to ${inv.email}.`).then(() => setInv({ email: '', role: 'analyst' })); }} className="mb-4 flex flex-wrap items-end gap-3">
            <Field label="Email" htmlFor="ie"><Input id="ie" type="email" required value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></Field>
            <Field label="Role" htmlFor="ir"><Select id="ir" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>{ROLES.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</Select></Field>
            <Button type="submit">Send invitation</Button>
          </form>
          <Async res={invites}>
            {({ data }) => <Table rows={data} rowKey={(r) => r.id} empty="No pending invitations." columns={[
              { key: 'e', header: 'Email', cell: (r) => r.email },
              { key: 'r', header: 'Role', cell: (r) => humanize(r.role) },
              { key: 'x', header: 'Expires', cell: (r) => formatDate(r.expires_at) },
              { key: 'a', header: '', cell: (r) => <Button size="sm" variant="ghost" onClick={() => run(() => del(`/orgs/${org.id}/invitations/${r.id}`), 'Invitation revoked.')}>Revoke</Button> },
            ]} />}
          </Async>
        </Card>
      )}
    </>
  );
}
