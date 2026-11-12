'use client';
import { useState } from 'react';
import { SAFETY_LEVEL_LABELS, SAFETY_LEVELS, TOPICS, safetyCategoryLabel, topicLabel, type PageSafety } from '@blissnova/shared';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Modal, PageHeader, Select, Textarea, cn } from '@/components/ui';
import { AdminTable } from '@/components/admin/kit';
import { SafetyBadge, TopicBadge, TopicPicker } from '@/components/topics/TopicUi';
import { errorMessage, post, put } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { formatNumber, timeAgo } from '@/lib/format';
import { useSession } from '@/lib/session';

interface PageRow {
  siteId: string; domain: string; orgName: string; path: string; title: string | null; language: string | null;
  topics: Array<{ id: string; score: number; confidence: number }>; primaryTopic: string | null; brandSafety: string;
  safetyFlags: Array<{ category: string; risk: string; score: number; terms: string[] }>; terms: string[]; enoughText: boolean;
  effectiveTopic: string | null; effectiveSafety: string;
  override: null | { topics: string[] | null; safety: string | null; note: string | null; by: string | null; at: string };
  classifiedAt: string; pageviews30d: number;
}

const FILTERS: Array<[string, string]> = [['', 'All pages'], ['flagged', 'Medium and high risk'], ...SAFETY_LEVELS.map((l) => [l, SAFETY_LEVEL_LABELS[l]] as [string, string])];

export default function AdminPageTopics() {
  const [safety, setSafety] = useState('flagged');
  const [topic, setTopic] = useState('');
  const [reviewed, setReviewed] = useState('');
  const [editing, setEditing] = useState<PageRow | null>(null);
  const [reload, setReload] = useState(0);
  const summary = useApi<{ summary: Record<string, number> }>(`/admin/page-topics?pageSize=1&_r=${reload}`);
  const canEdit = useSession().canAdmin('admin:inventory:manage');

  return (
    <>
      <PageHeader title="Page topics & brand safety" description="Every page that requests ads is classified on this server from its own text: its topics (IAB-style categories) and its brand-safety risk. High-risk pages show no ads. Correct a page here when detection gets it wrong; a correction wins until you clear it." />
      <div className="mb-4 flex flex-wrap gap-2">
        {(['high', 'medium', 'low', 'safe'] as const).map((l) => (
          <button key={l} onClick={() => setSafety(l)} className={cn('rounded-xl border border-border bg-surface px-4 py-2.5 text-left shadow-sm hover:bg-surface-2', safety === l && 'ring-2 ring-primary')}>
            <div className="text-xs text-muted">{SAFETY_LEVEL_LABELS[l]}</div>
            <div className="text-xl font-semibold tabular-nums">{formatNumber(summary.data?.summary[l] ?? 0)}</div>
          </button>
        ))}
      </div>
      <AdminTable<PageRow>
        path="/admin/page-topics"
        reloadKey={reload}
        extra={{ safety: safety || undefined, topic: topic || undefined, reviewed: reviewed || undefined }}
        rowKey={(r) => `${r.siteId}${r.path}`}
        toolbar={<>
          <Select aria-label="Risk" value={safety} onChange={(e) => setSafety(e.target.value)} className="max-w-[220px]">{FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
          <Select aria-label="Topic" value={topic} onChange={(e) => setTopic(e.target.value)} className="max-w-[220px]">
            <option value="">All topics</option><option value="none">Uncategorized</option>
            {TOPICS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
          <Select aria-label="Reviewed" value={reviewed} onChange={(e) => setReviewed(e.target.value)} className="max-w-[200px]">
            <option value="">Reviewed or not</option><option value="yes">Corrected by staff</option><option value="no">Detection only</option>
          </Select>
        </>}
        empty="No pages match. Pages appear here after the ad tag has requested ads on them."
        columns={[
          { key: 'p', header: 'Page', cell: (r) => (
            <div className="max-w-[340px]">
              <p className="truncate font-medium" title={r.title ?? undefined}>{r.title ?? r.path}</p>
              <p className="truncate text-xs text-muted">{r.domain}{r.path} · {r.orgName}</p>
            </div>
          ) },
          { key: 't', header: 'Topics', cell: (r) => (
            <div className="flex max-w-[260px] flex-wrap gap-1">
              {(r.override?.topics ?? r.topics.map((x) => x.id)).slice(0, 3).map((t, i) => <TopicBadge key={t} id={t} muted={i > 0} />)}
              {!(r.override?.topics ?? r.topics).length && <TopicBadge id={null} />}
              {r.override?.topics && <Badge tone="accent">Corrected</Badge>}
            </div>
          ) },
          { key: 's', header: 'Brand safety', cell: (r) => (
            <div className="space-y-1">
              <span className="inline-flex items-center gap-1"><SafetyBadge level={r.effectiveSafety} flags={r.safetyFlags} />{r.override?.safety && <Badge tone="accent">Corrected</Badge>}</span>
              {r.safetyFlags.length > 0 && <p className="max-w-[260px] text-xs text-muted">{r.safetyFlags.map((f) => `${safetyCategoryLabel(f.category)} (${f.risk})`).join(', ')}</p>}
            </div>
          ) },
          { key: 'v', header: 'Views (30 days)', align: 'right', cell: (r) => formatNumber(r.pageviews30d) },
          { key: 'c', header: 'Checked', cell: (r) => <span className="text-sm text-muted">{timeAgo(r.classifiedAt)}</span> },
          { key: 'a', header: '', align: 'right', cell: (r) => canEdit && <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>Review</Button> },
        ]}
      />
      {editing && <ReviewDialog page={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setReload((n) => n + 1); }} />}
      <ClassifierTester />
    </>
  );
}

function ReviewDialog({ page, onClose, onSaved }: { page: PageRow; onClose: () => void; onSaved: () => void }) {
  const [topics, setTopics] = useState<string[]>(page.override?.topics ?? page.topics.map((t) => t.id));
  const [safety, setSafety] = useState<string>(page.override?.safety ?? '');
  const [reason, setReason] = useState(page.override?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const detected = page.topics.map((t) => t.id);
  const sameTopics = topics.length === detected.length && topics.every((t, i) => t === detected[i]);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try { await fn(); onSaved(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const save = () => run(() => put('/admin/page-topics/override', { siteId: page.siteId, path: page.path, topics: sameTopics ? null : topics, safety: safety || null, reason }));
  return (
    <Modal open onClose={onClose} wide title={page.title ?? page.path} footer={<>
      {page.override && <Button variant="ghost" disabled={busy} onClick={() => run(() => put('/admin/page-topics/override', { siteId: page.siteId, path: page.path, topics: null, safety: null, reason: reason || 'Back to detection' }))}>Go back to detection</Button>}
      <Button variant="secondary" disabled={busy} onClick={() => run(() => post('/admin/page-topics/recheck', { siteId: page.siteId, path: page.path }))}>Check again on next visit</Button>
      <Button loading={busy} disabled={reason.trim().length < 3 || topics.length > 3} onClick={save}>Save correction</Button>
    </>}>
      <div className="space-y-4">
        <p className="text-sm text-muted">{page.domain}{page.path}{page.language ? ` · language ${page.language}` : ''}</p>
        {error && <Alert tone="danger">{error}</Alert>}
        {!page.enoughText && <Alert tone="info">The page had too little English text to judge its topics; it uses its site category until corrected.</Alert>}
        <div>
          <p className="mb-1 text-sm font-medium">Detected</p>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {page.topics.length ? page.topics.map((t) => <span key={t.id} className="inline-flex items-center gap-1"><TopicBadge id={t.id} /><span className="text-xs text-muted">{Math.round(t.confidence * 100)}%</span></span>) : <TopicBadge id={null} />}
            <SafetyBadge level={page.brandSafety} />
          </div>
          {page.terms.length > 0 && <p className="mt-1 text-xs text-muted">Signals: {page.terms.join(', ')}</p>}
          {page.safetyFlags.map((f) => <p key={f.category} className="mt-1 text-xs text-muted">{safetyCategoryLabel(f.category)} ({f.risk}): {f.terms.join(', ')}</p>)}
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Topics (up to 3, first is the main topic)</p>
          <TopicPicker label="Topics" value={topics} onChange={setTopics} />
          {topics.length > 3 && <p className="mt-1 text-xs text-danger">Choose at most 3.</p>}
        </div>
        <Field label="Brand safety" htmlFor="ov-safety">
          <Select id="ov-safety" value={safety} onChange={(e) => setSafety(e.target.value)}>
            <option value="">As detected ({SAFETY_LEVEL_LABELS[page.brandSafety as PageSafety] ?? page.brandSafety})</option>
            {SAFETY_LEVELS.map((l) => <option key={l} value={l}>{SAFETY_LEVEL_LABELS[l]}</option>)}
          </Select>
        </Field>
        <Field label="Reason" htmlFor="ov-reason" required hint="Recorded in the audit log."><Textarea id="ov-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function ClassifierTester() {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<null | { topics: Array<{ id: string; confidence: number }>; safety: string; flags: Array<{ category: string; risk: string; terms: string[] }>; terms: string[]; enoughText: boolean }>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card className="mt-5">
      <CardHeader title="Try the classifier" description="Paste a page title and some text to see the topics and risk a page like it would get. Nothing is stored." />
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setError(null);
        try { setResult((await post('/admin/page-topics/test', { title, text })).data); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
      }}>
        <Field label="Title" htmlFor="tt"><Input id="tt" maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Weekend in Lisbon on a budget" /></Field>
        <Field label="Text" htmlFor="tx"><Textarea id="tx" rows={4} maxLength={6000} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        <div><Button type="submit" loading={busy} disabled={!title.trim() && !text.trim()}>Classify</Button></div>
      </form>
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
      {result && (
        <div className="mt-4 space-y-2 rounded-lg border border-border bg-surface-2/50 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Topics:</span>
            {result.topics.length ? result.topics.map((t) => <span key={t.id} className="inline-flex items-center gap-1"><TopicBadge id={t.id} /><span className="text-xs text-muted">{Math.round(t.confidence * 100)}%</span></span>) : <span>{result.enoughText ? 'None strong enough' : 'Not enough English text'}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2"><span className="text-muted">Brand safety:</span><SafetyBadge level={result.safety} />
            {result.flags.map((f) => <span key={f.category} className="text-xs text-muted">{safetyCategoryLabel(f.category)} ({f.risk}): {f.terms.join(', ')}</span>)}
          </div>
          {result.terms.length > 0 && <div className="text-xs text-muted">Signals: {result.terms.join(', ')}</div>}
          <p className="text-xs text-muted">Topic names: {result.topics.map((t) => topicLabel(t.id)).join(', ') || '—'}</p>
        </div>
      )}
    </Card>
  );
}
