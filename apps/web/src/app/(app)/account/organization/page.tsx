'use client';
import { useState, type FormEvent } from 'react';
import { Alert, Async, Button, Card, CardHeader, Checkbox, DefinitionList, Field, Input, PageHeader, StatusBadge } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { useOrg, useSession } from '@/lib/session';
import { errorMessage, patch } from '@/lib/api';
import { formatDate, humanize } from '@/lib/format';

export default function Organization() {
  const org = useOrg();
  const { can, refresh } = useSession();
  const res = useApi<{ data: any }>(`/orgs/${org.id}`);
  return (
    <>
      <PageHeader title="Organization" />
      <Async res={res}>
        {({ data }) => <OrgForm data={data} editable={can('org:update')} onSaved={(d) => { res.setData({ data: { ...data, ...d } }); void refresh(); }} />}
      </Async>
    </>
  );
}

function OrgForm({ data, editable, onSaved }: { data: any; editable: boolean; onSaved: (d: any) => void }) {
  const [f, setF] = useState({ name: data.name ?? '', website: data.website ?? '', country: data.country ?? '', billingEmail: data.billingEmail ?? '', sellersJsonConfidential: !!data.sellersJsonConfidential });
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const r = await patch<{ data: any }>(`/orgs/${data.id}`, { name: f.name, website: f.website || null, country: f.country || null, billingEmail: f.billingEmail || null, ...(data.type === 'publisher' ? { sellersJsonConfidential: f.sellersJsonConfidential } : {}) });
      onSaved(r.data);
      setMsg({ tone: 'success', text: 'Saved.' });
    } catch (err) {
      setMsg({ tone: 'danger', text: errorMessage(err) });
    }
  }
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <Card>
        <CardHeader title="Details" />
        <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
          {msg && <Alert tone={msg.tone} className="sm:col-span-2">{msg.text}</Alert>}
          <Field label="Name" htmlFor="on" required className="sm:col-span-2"><Input id="on" required disabled={!editable} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Website" htmlFor="ow"><Input id="ow" type="url" disabled={!editable} value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} placeholder="https://" /></Field>
          <Field label="Country" htmlFor="oc" hint="Two-letter code"><Input id="oc" maxLength={2} disabled={!editable} value={f.country} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} /></Field>
          <Field label="Billing email" htmlFor="ob" className="sm:col-span-2"><Input id="ob" type="email" disabled={!editable} value={f.billingEmail} onChange={(e) => setF({ ...f, billingEmail: e.target.value })} /></Field>
          {data.type === 'publisher' && <div className="sm:col-span-2"><Checkbox label="Keep our name and domain out of sellers.json" hint="Buyers then see only your seller id. Some buyers bid less, or not at all, on confidential sellers." checked={f.sellersJsonConfidential} disabled={!editable} onChange={(v) => setF({ ...f, sellersJsonConfidential: v })} /></div>}
          {editable && <div><Button type="submit">Save</Button></div>}
        </form>
      </Card>
      <Card>
        <CardHeader title="Account" />
        <DefinitionList items={[['Type', humanize(data.type)], ['Status', <StatusBadge key="s" status={data.status} />], ['Currency', data.currency], ['Your role', humanize(data.role)], ['Created', formatDate(data.createdAt)]]} />
        {data.status === 'pending' && <p className="mt-3 text-sm text-muted">New organizations are reviewed by the network team before they can serve ads or receive payouts.</p>}
        {data.statusReason && <Alert tone="warning" className="mt-3">{data.statusReason}</Alert>}
      </Card>
    </div>
  );
}
