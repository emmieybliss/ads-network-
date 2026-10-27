'use client';
import { useState, type FormEvent } from 'react';
import { Alert, Async, Badge, Button, Card, Checkbox, Field, Input, Modal, PageHeader, Select, Table, Textarea } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { del, errorMessage, post, put } from '@/lib/api';
import { humanize, timeAgo } from '@/lib/format';

const KINDS = ['faq', 'advertiser_policy', 'publisher_policy', 'creative_rules', 'announcement', 'maintenance_notice', 'support_contact', 'doc_link', 'legal'];
const EMPTY = { kind: 'faq', slug: '', title: '', body: '', url: '', sortOrder: 0, published: false };

export default function Content() {
  const { canAdmin } = useSession();
  const manage = canAdmin('admin:content:manage');
  const res = useApi<{ data: any[] }>('/admin/content');
  const [kind, setKind] = useState('');
  const [edit, setEdit] = useState<(typeof EMPTY & { id?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    const { id, ...body } = edit!;
    try {
      if (id) await put(`/admin/content/${id}`, { ...body, url: body.url || null });
      else await post('/admin/content', { ...body, url: body.url || null });
      setEdit(null);
      res.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <>
      <PageHeader title="Content" description="FAQs, policies, legal pages, announcements and documentation links. Legal text must be reviewed by a qualified professional before publishing." actions={manage && <Button onClick={() => { setError(null); setEdit({ ...EMPTY }); }}>New item</Button>} />
      <Card>
        <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} className="mb-4 max-w-[220px]"><option value="">All kinds</option>{KINDS.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</Select>
        <Async res={res}>{({ data }) => <Table rows={data.filter((r) => !kind || r.kind === kind)} rowKey={(r) => r.id} empty="No content." columns={[
          { key: 'k', header: 'Kind', cell: (r) => humanize(r.kind) }, { key: 't', header: 'Title', cell: (r) => <span className="font-medium">{r.title}</span> }, { key: 's', header: 'Slug', cell: (r) => <code className="text-xs">{r.slug}</code> },
          { key: 'p', header: 'Status', cell: (r) => (r.published ? <Badge tone="success">Published</Badge> : <Badge>Draft</Badge>) }, { key: 'u', header: 'Updated', cell: (r) => timeAgo(r.updated_at) },
          { key: 'x', header: '', cell: (r) => manage && <span className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => { setError(null); setEdit({ id: r.id, kind: r.kind, slug: r.slug, title: r.title, body: r.body, url: r.url ?? '', sortOrder: r.sort_order, published: r.published }); }}>Edit</Button>
            <Button size="sm" variant="ghost" onClick={async () => { if (confirm(`Delete “${r.title}”?`)) { await del(`/admin/content/${r.id}`); res.reload(); } }}>Delete</Button>
          </span> },
        ]} />}</Async>
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} wide title={edit?.id ? 'Edit content' : 'New content'} footer={<Button type="submit" form="content">Save</Button>}>
        {edit && (
          <form id="content" onSubmit={save} className="grid gap-4 sm:grid-cols-2">
            {error && <Alert tone="danger" className="sm:col-span-2">{error}</Alert>}
            <Field label="Kind" htmlFor="ck"><Select id="ck" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</Select></Field>
            <Field label="Slug" htmlFor="cs" hint="Lowercase letters, numbers and hyphens"><Input id="cs" required pattern="^[a-z0-9-]{1,80}$" value={edit.slug} onChange={(e) => setEdit({ ...edit, slug: e.target.value })} /></Field>
            <Field label="Title" htmlFor="ct" required className="sm:col-span-2"><Input id="ct" required value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label="Body" htmlFor="cb" className="sm:col-span-2" hint="Plain text with blank lines between paragraphs. Lines starting with “# ” become headings and “- ” become list items."><Textarea id="cb" rows={12} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
            <Field label="Link URL" htmlFor="cu" hint="For documentation links"><Input id="cu" value={edit.url} onChange={(e) => setEdit({ ...edit, url: e.target.value })} /></Field>
            <Field label="Order" htmlFor="co"><Input id="co" type="number" min={0} value={edit.sortOrder} onChange={(e) => setEdit({ ...edit, sortOrder: Number(e.target.value) })} /></Field>
            <Checkbox label="Published" checked={edit.published} onChange={(v) => setEdit({ ...edit, published: v })} />
          </form>
        )}
      </Modal>
    </>
  );
}
