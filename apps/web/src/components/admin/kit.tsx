'use client';
import { useState, type ReactNode } from 'react';
import { Alert, Async, Button, Card, CardHeader, Input, Pagination, ReasonDialog, Select, Table, Textarea, type Column } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { errorMessage, post, qs } from '@/lib/api';
import { humanize, timeAgo } from '@/lib/format';

export interface Paged<T> { data: T[]; meta: { page: number; pageSize: number; total: number } }

/** Server-paginated admin list with search and status filter. */
export function AdminTable<T>({ path, columns, rowKey, statuses, extra = {}, onRowClick, search = true, empty, toolbar, reloadKey }: {
  path: string; columns: Column<T>[]; rowKey: (r: T) => string; statuses?: string[]; extra?: Record<string, string | undefined>;
  onRowClick?: (r: T) => void; search?: boolean; empty?: ReactNode; toolbar?: ReactNode; reloadKey?: number;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const res = useApi<Paged<T>>(`${path}${qs({ q: q || undefined, status: status || undefined, page, pageSize: 25, ...extra, _r: reloadKey })}`);
  return (
    <Card>
      {(search || statuses || toolbar) && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {search && <Input placeholder="Search" aria-label="Search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-xs" />}
          {statuses && (
            <Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="max-w-[220px]">
              <option value="">All statuses</option>
              {statuses.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </Select>
          )}
          {toolbar}
        </div>
      )}
      <Async res={res}>
        {({ data, meta }) => (
          <>
            <Table columns={columns} rows={data} rowKey={rowKey} onRowClick={onRowClick} empty={empty ?? 'Nothing here.'} />
            <Pagination page={meta.page} pageSize={meta.pageSize} total={meta.total} onPage={setPage} />
          </>
        )}
      </Async>
    </Card>
  );
}

/** A button that asks for a reason, then posts it. Step-up confirmation is handled by the API client. */
export function ReasonAction({ label, title, path, variant = 'secondary', danger, requireReason = true, body = {}, onDone, description, run }: {
  label: ReactNode; title: string; path: string; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; danger?: boolean; requireReason?: boolean;
  body?: Record<string, unknown>; onDone: () => void; description?: ReactNode; run?: (reason: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>{label}</Button>
      <ReasonDialog open={open} onClose={() => setOpen(false)} title={title} description={description} danger={danger} requireReason={requireReason} confirmLabel={typeof label === 'string' ? label : 'Confirm'}
        onConfirm={async (reason) => { if (run) await run(reason); else await post(path, { ...body, reason: reason || undefined }); setOpen(false); onDone(); }} />
    </>
  );
}

/** Internal staff notes on any subject. Never visible to customers. */
export function NotesPanel({ subjectType, subjectId }: { subjectType: string; subjectId: string }) {
  const res = useApi<{ data: Array<{ id: string; body: string; created_at: string; author: string }> }>(`/admin/notes${qs({ subjectType, subjectId })}`);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Internal notes" description="Visible to staff only." />
      {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
      <form className="mb-4 space-y-2" onSubmit={async (e) => { e.preventDefault(); try { await post('/admin/notes', { subjectType, subjectId, body }); setBody(''); res.reload(); } catch (err) { setError(errorMessage(err)); } }}>
        <Textarea aria-label="Note" rows={2} required value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note" />
        <Button size="sm" type="submit">Add note</Button>
      </form>
      <Async res={res}>
        {({ data }) => data.length === 0 ? <p className="text-sm text-muted">No notes.</p> : (
          <ul className="space-y-3">{data.map((n) => <li key={n.id} className="text-sm"><p className="whitespace-pre-wrap">{n.body}</p><p className="text-xs text-muted">{n.author} · {timeAgo(n.created_at)}</p></li>)}</ul>
        )}
      </Async>
    </Card>
  );
}

export function SimpleTable<T>({ rows, columns, rowKey, empty }: { rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; empty?: ReactNode }) {
  return <Table rows={rows} columns={columns} rowKey={rowKey} empty={empty ?? 'None.'} />;
}
