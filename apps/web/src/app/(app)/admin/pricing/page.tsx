'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Alert, Async, Badge, Button, Card, CardHeader, Checkbox, Field, Input, Modal, PageHeader, Select, Table, Textarea } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { del, errorMessage, post, put } from '@/lib/api';
import { humanize } from '@/lib/format';

const EMPTY = { audience: 'advertiser', name: '', summary: '', priceLabel: '', features: '', ctaLabel: 'Get started', highlighted: false, sortOrder: 0, published: false };

export default function Pricing() {
  const { canAdmin } = useSession();
  const manage = canAdmin('admin:pricing:manage');
  const plans = useApi<{ data: any[] }>('/admin/pricing-plans');
  const rules = useApi<{ data: any[] }>('/admin/inventory-rules');
  const [edit, setEdit] = useState<(typeof EMPTY & { id?: string }) | null>(null);
  const [rule, setRule] = useState({ kind: 'blocked_destination_domain', value: '', reason: '' });
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const body = { ...edit!, features: edit!.features.split('\n').map((x) => x.trim()).filter(Boolean), sortOrder: Number(edit!.sortOrder) };
    delete (body as { id?: string }).id;
    try {
      if (edit!.id) await put(`/admin/pricing-plans/${edit!.id}`, body);
      else await post('/admin/pricing-plans', body);
      setEdit(null);
      plans.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader title="Pricing" description="Plans shown on the public pricing section, and inventory rules. Minimum rates and enabled pricing models are in Settings → Pricing." actions={<Link href="/admin/settings?group=pricing" className="text-sm text-primary hover:underline">Pricing settings</Link>} />
      {error && !edit && <Alert tone="danger" className="mb-4">{error}</Alert>}
      <Card>
        <CardHeader title="Pricing plans" description="Describe how pricing works. Do not publish prices or promises the business has not decided on." actions={manage && <Button size="sm" onClick={() => setEdit({ ...EMPTY })}>Add plan</Button>} />
        <Async res={plans}>{({ data }) => <Table rows={data} rowKey={(r) => r.id} empty="No plans." columns={[
          { key: 'a', header: 'Audience', cell: (r) => humanize(r.audience) },
          { key: 'n', header: 'Name', cell: (r) => <span className="font-medium">{r.name}</span> },
          { key: 'p', header: 'Price label', cell: (r) => r.price_label },
          { key: 's', header: 'Published', cell: (r) => (r.published ? <Badge tone="success">Published</Badge> : <Badge>Draft</Badge>) },
          { key: 'x', header: '', cell: (r) => manage && <span className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEdit({ id: r.id, audience: r.audience, name: r.name, summary: r.summary, priceLabel: r.price_label, features: (r.features ?? []).join('\n'), ctaLabel: r.cta_label, highlighted: r.highlighted, sortOrder: r.sort_order, published: r.published })}>Edit</Button>
            <Button size="sm" variant="ghost" onClick={async () => { if (confirm('Delete this plan?')) { await del(`/admin/pricing-plans/${r.id}`); plans.reload(); } }}>Delete</Button>
          </span> },
        ]} />}</Async>
      </Card>
      <Card className="mt-5">
        <CardHeader title="Inventory rules" description="Network-wide blocks applied at creative review and ad serving." />
        {canAdmin('admin:inventory:manage') && (
          <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={async (e) => { e.preventDefault(); try { await post('/admin/inventory-rules', { ...rule, reason: rule.reason || undefined }); setRule({ ...rule, value: '', reason: '' }); rules.reload(); } catch (err) { setError(errorMessage(err)); } }}>
            <Field label="Rule" htmlFor="rk"><Select id="rk" value={rule.kind} onChange={(e) => setRule({ ...rule, kind: e.target.value })}>{['blocked_destination_domain', 'blocked_keyword', 'blocked_site_category', 'blocked_country'].map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</Select></Field>
            <Field label="Value" htmlFor="rv"><Input id="rv" required value={rule.value} onChange={(e) => setRule({ ...rule, value: e.target.value })} /></Field>
            <Field label="Reason" htmlFor="rr"><Input id="rr" value={rule.reason} onChange={(e) => setRule({ ...rule, reason: e.target.value })} /></Field>
            <Button type="submit">Add rule</Button>
          </form>
        )}
        <Async res={rules}>{({ data }) => <Table rows={data} rowKey={(r) => r.id} empty="No rules." columns={[
          { key: 'k', header: 'Rule', cell: (r) => humanize(r.kind) }, { key: 'v', header: 'Value', cell: (r) => <code className="text-xs">{r.value}</code> }, { key: 'r', header: 'Reason', cell: (r) => r.reason ?? '' },
          { key: 'x', header: '', cell: (r) => canAdmin('admin:inventory:manage') && <Button size="sm" variant="ghost" onClick={async () => { await del(`/admin/inventory-rules/${r.id}`); rules.reload(); }}>Remove</Button> },
        ]} />}</Async>
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} wide title={edit?.id ? 'Edit plan' : 'New plan'} footer={<Button type="submit" form="plan">Save</Button>}>
        {edit && (
          <form id="plan" onSubmit={save} className="grid gap-4 sm:grid-cols-2">
            {error && <Alert tone="danger" className="sm:col-span-2">{error}</Alert>}
            <Field label="Audience" htmlFor="pa"><Select id="pa" value={edit.audience} onChange={(e) => setEdit({ ...edit, audience: e.target.value })}><option value="advertiser">Advertisers</option><option value="publisher">Publishers</option></Select></Field>
            <Field label="Name" htmlFor="pn" required><Input id="pn" required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Price label" htmlFor="pp" hint="For example “Set per campaign”."><Input id="pp" value={edit.priceLabel} onChange={(e) => setEdit({ ...edit, priceLabel: e.target.value })} /></Field>
            <Field label="Button label" htmlFor="pc"><Input id="pc" value={edit.ctaLabel} onChange={(e) => setEdit({ ...edit, ctaLabel: e.target.value })} /></Field>
            <Field label="Summary" htmlFor="ps" className="sm:col-span-2"><Input id="ps" value={edit.summary} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} /></Field>
            <Field label="Features (one per line)" htmlFor="pf" className="sm:col-span-2"><Textarea id="pf" rows={5} value={edit.features} onChange={(e) => setEdit({ ...edit, features: e.target.value })} /></Field>
            <Field label="Order" htmlFor="po"><Input id="po" type="number" min={0} value={edit.sortOrder} onChange={(e) => setEdit({ ...edit, sortOrder: Number(e.target.value) })} /></Field>
            <div className="space-y-2 pt-6"><Checkbox label="Highlight" checked={edit.highlighted} onChange={(v) => setEdit({ ...edit, highlighted: v })} /><Checkbox label="Published" checked={edit.published} onChange={(v) => setEdit({ ...edit, published: v })} /></div>
          </form>
        )}
      </Modal>
    </>
  );
}
