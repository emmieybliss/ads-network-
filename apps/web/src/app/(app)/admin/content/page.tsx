'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Alert, Async, Badge, Button, Card, Checkbox, Field, Input, Modal, PageHeader, Select, Table, Textarea } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { del, errorMessage, post, put } from '@/lib/api';
import { humanize, timeAgo } from '@/lib/format';

const KINDS = ['faq', 'advertiser_policy', 'publisher_policy', 'creative_rules', 'announcement', 'maintenance_notice', 'support_contact', 'doc_link', 'legal'];
const PUBLIC_PATH: Record<string, (slug: string) => string> = {
  legal: (slug) => `/legal/${slug}`,
  publisher_policy: () => '/policies/publishers',
  advertiser_policy: () => '/policies/advertisers',
  creative_rules: () => '/policies/creatives',
  faq: () => '/#faq',
};
type ContentRes = { data: any[]; missingDetails: Array<{ key: string; label: string }>; starterMissing: number; tokens: Record<string, string> };
const EMPTY = { kind: 'faq', slug: '', title: '', body: '', url: '', sortOrder: 0, published: false };

export default function Content() {
  const { canAdmin } = useSession();
  const manage = canAdmin('admin:content:manage');
  const res = useApi<ContentRes>('/admin/content');
  const [starter, setStarter] = useState<{ publish: boolean; busy: boolean; error: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function installStarter() {
    setStarter({ ...starter!, busy: true, error: null });
    try {
      const r = await post<{ data: { added: number; replaced: number } }>('/admin/content/starter', { publish: starter!.publish });
      setStarter(null);
      setNotice(`Added ${r.data.added} draft(s)${r.data.replaced ? ` and replaced ${r.data.replaced} placeholder(s)` : ''}. Existing items you have edited were left as they are.`);
      res.reload();
    } catch (err) {
      setStarter({ ...starter!, busy: false, error: errorMessage(err) });
    }
  }
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
      {notice && <Alert tone="success" className="mb-4">{notice}</Alert>}
      {res.data && res.data.missingDetails.length > 0 && (
        <Alert tone="warning" className="mb-4" title="Company details are missing from the legal pages">
          {res.data.missingDetails.map((d) => d.label).join(', ')} {res.data.missingDetails.length === 1 ? 'is' : 'are'} not set, so {res.data.missingDetails.length === 1 ? 'it shows' : 'they show'} as highlighted gaps in the published documents. <Link className="font-medium underline" href="/admin/settings?group=branding">Complete them in Settings › Branding</Link>.
        </Alert>
      )}
      {res.data && res.data.starterMissing > 0 && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="max-w-2xl">
              <p className="font-medium text-fg">Starter legal pages, policies and FAQs</p>
              <p className="mt-1 text-sm text-muted">{res.data.starterMissing} ready-written draft(s) are not installed yet: terms of service, publisher and advertiser terms, privacy and cookie policies, publisher and advertiser policies, creative rules and FAQs. They describe how this platform works and fill in your company details automatically. Have them reviewed by a lawyer before launch.</p>
            </div>
            {manage && <Button variant="secondary" onClick={() => setStarter({ publish: false, busy: false, error: null })}>Install drafts</Button>}
          </div>
        </Card>
      )}
      <Card>
        <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} className="mb-4 max-w-[220px]"><option value="">All kinds</option>{KINDS.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</Select>
        <Async res={res}>{({ data }) => <Table rows={data.filter((r) => !kind || r.kind === kind)} rowKey={(r) => r.id} empty="No content." columns={[
          { key: 'k', header: 'Kind', cell: (r) => humanize(r.kind) }, { key: 't', header: 'Title', cell: (r) => <span className="font-medium">{r.title}</span> }, { key: 's', header: 'Slug', cell: (r) => <code className="text-xs">{r.slug}</code> },
          { key: 'p', header: 'Status', cell: (r) => (r.published ? <Badge tone="success">Published</Badge> : <Badge>Draft</Badge>) }, { key: 'u', header: 'Updated', cell: (r) => timeAgo(r.updated_at) },
          { key: 'x', header: '', cell: (r) => <span className="flex gap-1">
            {r.published && PUBLIC_PATH[r.kind] && <Link className="inline-flex items-center rounded-lg px-2.5 py-1 text-sm text-primary hover:bg-surface-2" href={PUBLIC_PATH[r.kind]!(r.slug)} target="_blank">View</Link>}
            {manage && <>
            <Button size="sm" variant="ghost" onClick={() => { setError(null); setEdit({ id: r.id, kind: r.kind, slug: r.slug, title: r.title, body: r.body, url: r.url ?? '', sortOrder: r.sort_order, published: r.published }); }}>Edit</Button>
            <Button size="sm" variant="ghost" onClick={async () => { if (confirm(`Delete “${r.title}”?`)) { await del(`/admin/content/${r.id}`); res.reload(); } }}>Delete</Button>
            </>}
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
            <Field label="Body" htmlFor="cb" className="sm:col-span-2" hint={<>Plain text with blank lines between paragraphs. Lines starting with “# ” become headings, “## ” sub-headings and “- ” list items. Placeholders filled from Settings: {Object.keys(res.data?.tokens ?? {}).map((t) => `{{${t}}}`).join(' ')}</>}><Textarea id="cb" rows={16} className="font-mono text-[13px]" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
            <Field label="Link URL" htmlFor="cu" hint="For documentation links"><Input id="cu" value={edit.url} onChange={(e) => setEdit({ ...edit, url: e.target.value })} /></Field>
            <Field label="Order" htmlFor="co"><Input id="co" type="number" min={0} value={edit.sortOrder} onChange={(e) => setEdit({ ...edit, sortOrder: Number(e.target.value) })} /></Field>
            <Checkbox label="Published" checked={edit.published} onChange={(v) => setEdit({ ...edit, published: v })} />
          </form>
        )}
      </Modal>
      <Modal open={!!starter} onClose={() => setStarter(null)} title="Install starter drafts" footer={<Button onClick={installStarter} loading={starter?.busy}>Install</Button>}>
        {starter && (
          <div className="space-y-4 text-sm">
            {starter.error && <Alert tone="danger">{starter.error}</Alert>}
            <p>Adds every starter document that is not here yet. Items you already have are left alone, except unedited placeholders from the original setup, which are replaced.</p>
            <p className="text-muted">These are drafts modelled on established ad networks’ terms and program policies. They are not legal advice: have a qualified lawyer review them for your company and countries before launch.</p>
            <Checkbox label="Publish them now" checked={starter.publish} onChange={(v) => setStarter({ ...starter, publish: v })} />
          </div>
        )}
      </Modal>
    </>
  );
}
