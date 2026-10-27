'use client';
import { useState, type FormEvent } from 'react';
import { CheckCircle2, FlaskConical, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { Alert, Async, Badge, Button, Card, CardHeader, Checkbox, CodeBlock, CopyButton, Field, Input, Modal, Select, StatusBadge, Table, Textarea } from '@/components/ui';
import { useApi, useConfig } from '@/lib/hooks';
import { ApiError, errorMessage, patch, post } from '@/lib/api';
import { formatDate, formatNumber, humanize, timeAgo } from '@/lib/format';

export const CATEGORIES = ['general', 'news', 'technology', 'business', 'finance', 'lifestyle', 'entertainment', 'sports', 'education', 'health', 'travel', 'food', 'automotive', 'gaming', 'parenting', 'real_estate', 'science', 'other'];
const METHOD_LABEL: Record<string, string> = { dns_txt: 'DNS TXT record', html_file: 'HTML file upload', meta_tag: 'HTML meta tag', manual: 'Manual (staff)', simulated: 'Development simulator' };
const METHOD_HINT: Record<string, string> = {
  dns_txt: 'Best if you manage DNS. Covers subdomains of this domain.',
  html_file: 'Upload a small text file to your web server. Covers this exact hostname.',
  meta_tag: 'Add a tag to your homepage <head>. Covers this exact hostname.',
};

export type SiteDetail = Record<string, any> & {
  id: string; domain: string; status: string;
  verification: { verified: boolean; method: string | null; scope: string | null; simulated: boolean; verifiedAt: string | null; allowedMethods: string[]; simulatorAvailable: boolean; challenge: null | { id: string; method: string; hostname: string; status: string; attempts: number; expiresAt: string; expired: boolean; lastCheckedAt: string | null; lastError: string | null; instructions: { label: string; instructions: string; value: string; recordName?: string; url?: string } }; history: Array<{ method: string; outcome: string; detail: string | null; simulated: boolean; at: string }> };
  submission: { policyVersion: string; policyAcceptedAt: string | null; acceptedPolicyVersion: string | null; submittedAt: string | null; canSubmit: boolean };
  reviews: Array<{ action: string; status: string; reason: string | null; at: string }>;
};

export function VerificationPanel({ orgId, site, onChange }: { orgId: string; site: SiteDetail; onChange: (s: SiteDetail) => void }) {
  const v = site.verification;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const base = `/orgs/${orgId}/sites/${site.id}`;

  async function run(kind: string, fn: () => Promise<{ data: SiteDetail; verified?: boolean; error?: string }>) {
    setBusy(kind);
    setError(null);
    setResult(null);
    try {
      const r = await fn();
      onChange(r.data);
      if (r.verified === false) setResult(r.error ?? 'The proof was not found yet.');
    } catch (e) {
      setError(e instanceof ApiError && e.status === 429 ? 'Too many checks for this domain in the last hour. Try again later.' : errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (v.verified) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-6 text-success" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Ownership of {site.domain} is verified</p>
            <p className="text-sm text-muted">Verified {formatDate(v.verifiedAt, true)} with {METHOD_LABEL[v.method ?? ''] ?? humanize(v.method)}. {v.scope === 'zone' ? 'Subdomains are covered.' : 'Covers this exact hostname only.'}</p>
            {v.simulated && <Alert tone="warning" className="mt-3" title="Simulated verification">This site was verified by the local development simulator. Simulated sites are never served in production.</Alert>}
            <p className="mt-2 text-sm text-muted">Verification proves you control the domain. It does not approve the site; approval follows a review.</p>
          </div>
        </div>
      </Card>
    );
  }

  const ch = v.challenge;
  return (
    <Card>
      <CardHeader title="Verify that you own this domain" description="Choose one method. We check automatically when you press Check now; nothing on your site is changed by us." />
      {error && <Alert tone="danger" className="mb-4">{error}</Alert>}
      {!ch || ch.expired ? (
        <>
          {ch?.expired && <Alert tone="warning" className="mb-4">Your previous verification code expired. Start again to get a new one.</Alert>}
          <div className="grid gap-3 md:grid-cols-3">
            {v.allowedMethods.map((m) => (
              <button key={m} disabled={!!busy} onClick={() => run(m, () => post(`${base}/verification/challenge`, { method: m }))} className="rounded-xl border border-border p-4 text-left transition hover:border-primary hover:bg-primary-soft/40 disabled:opacity-60">
                <p className="font-medium">{METHOD_LABEL[m]}</p>
                <p className="mt-1 text-sm text-muted">{METHOD_HINT[m]}</p>
                {busy === m && <p className="mt-2 text-xs text-primary">Creating code…</p>}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="info">{ch.instructions.label}</Badge>
            <span className="text-muted">for {ch.hostname} · code expires {formatDate(ch.expiresAt, true)}</span>
          </div>
          <p className="text-sm text-fg-2">{ch.instructions.instructions}</p>
          {ch.instructions.recordName && <div><p className="mb-1 text-xs font-medium text-muted">Record name</p><div className="flex items-center gap-2"><code className="break-all rounded bg-surface-2 px-2 py-1 text-xs">{ch.instructions.recordName}</code><CopyButton value={ch.instructions.recordName} /></div></div>}
          {ch.instructions.url && <div><p className="mb-1 text-xs font-medium text-muted">File location</p><code className="break-all rounded bg-surface-2 px-2 py-1 text-xs">{ch.instructions.url}</code></div>}
          <CodeBlock label={ch.method === 'dns_txt' ? 'TXT value' : ch.method === 'html_file' ? 'File content' : 'Meta tag'} code={ch.instructions.value} />
          {result && <Alert tone="warning" title="Not verified yet">{result}</Alert>}
          {ch.lastCheckedAt && !result && <p className="text-xs text-muted">Last checked {timeAgo(ch.lastCheckedAt)}{ch.lastError ? `: ${ch.lastError}` : ''}. {ch.attempts} check{ch.attempts === 1 ? '' : 's'} so far.</p>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => run('check', () => post(`${base}/verification/check`))} loading={busy === 'check'}><RefreshCw className="size-4" /> Check now</Button>
            <Button variant="secondary" onClick={() => run('restart', () => post(`${base}/verification/challenge`, { method: ch.method === 'dns_txt' ? 'html_file' : 'dns_txt' }))} disabled={!!busy}>Use a different method</Button>
          </div>
        </div>
      )}
      {v.simulatorAvailable && (
        <div className="mt-5 rounded-xl border border-dashed border-warning/60 bg-warning-soft/50 p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-warning"><FlaskConical className="size-4" /> Development simulator</p>
          <p className="mt-1 text-sm text-fg-2">{site.domain} is a reserved local name that cannot be checked over the internet. In local development you can simulate a successful check. The site will be marked as simulated and is never served in production.</p>
          <Button size="sm" variant="secondary" className="mt-3" loading={busy === 'sim'} onClick={() => run('sim', () => post(`${base}/verification/simulate`, { method: ch?.method ?? 'dns_txt' }))}>Simulate verification</Button>
        </div>
      )}
      {v.history.length > 0 && (
        <details className="mt-5">
          <summary className="cursor-pointer text-sm text-muted">Check history ({v.history.length})</summary>
          <Table rows={v.history} rowKey={(r) => r.at + r.method} columns={[
            { key: 'a', header: 'When', cell: (r) => timeAgo(r.at) },
            { key: 'm', header: 'Method', cell: (r) => METHOD_LABEL[r.method] ?? r.method },
            { key: 'o', header: 'Result', cell: (r) => <StatusBadge status={r.outcome} /> },
            { key: 'd', header: 'Detail', cell: (r) => r.detail ?? '' },
          ]} />
        </details>
      )}
    </Card>
  );
}

export function SubmitPanel({ orgId, site, onChange }: { orgId: string; site: SiteDetail; onChange: (s: SiteDetail) => void }) {
  const cfg = useConfig().data?.data;
  const e = cfg?.eligibility;
  const [f, setF] = useState({ category: site.category ?? 'general', description: site.description ?? '', language: site.language ?? 'en', country: site.country ?? '', reportedMonthlyPageviews: site.reportedMonthlyPageviews ? String(site.reportedMonthlyPageviews) : '', trafficSources: site.trafficSources ?? '' });
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = site.submission;

  if (!s.canSubmit) {
    if (['submitted', 'under_review'].includes(site.status)) return <Card><CardHeader title="Submitted for review" /><p className="text-sm text-fg-2">Submitted {formatDate(s.submittedAt, true)}. Our team reviews content, policy compliance and traffic quality. You will be notified of the decision.</p></Card>;
    if (site.status === 'approved') return null;
    return <Card><CardHeader title="Submit for review" /><p className="text-sm text-muted">{site.status === 'suspended' ? 'This site is suspended. Contact support to discuss reinstatement.' : 'Verify ownership first. You can then submit the site for review.'}</p></Card>;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ data: SiteDetail }>(`/orgs/${orgId}/sites/${site.id}/submit`, {
        category: f.category, description: f.description, language: f.language, country: f.country,
        reportedMonthlyPageviews: f.reportedMonthlyPageviews ? Number(f.reportedMonthlyPageviews) : undefined, trafficSources: f.trafficSources || undefined,
        policyVersion: s.policyVersion, acceptPolicies: accept,
      });
      onChange(r.data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Submit for review" description="Tell us about the site. A reviewer checks it against the publisher requirements before ads can serve." />
      {site.status === 'rejected' && site.statusReason && <Alert tone="danger" className="mb-4" title="Previous review">{site.statusReason}</Alert>}
      {error && <Alert tone="danger" className="mb-4">{error}</Alert>}
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Category" htmlFor="cat"><Select id="cat" value={f.category} onChange={(x) => setF({ ...f, category: x.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select></Field>
        <Field label="Main language" htmlFor="lang" hint="For example en or en-GB" required><Input id="lang" required value={f.language} onChange={(x) => setF({ ...f, language: x.target.value })} /></Field>
        <Field label="Main audience country" htmlFor="ctry" hint="Two-letter code, for example US" required><Input id="ctry" required maxLength={2} value={f.country} onChange={(x) => setF({ ...f, country: x.target.value.toUpperCase() })} /></Field>
        <Field label="Monthly page views (your estimate)" htmlFor="pv" hint={e?.minMonthlyPageviews ? `Current minimum: ${formatNumber(e.minMonthlyPageviews)}` : 'Optional. No fixed minimum is currently set.'}><Input id="pv" type="number" min={0} value={f.reportedMonthlyPageviews} onChange={(x) => setF({ ...f, reportedMonthlyPageviews: x.target.value })} /></Field>
        <Field label="Describe the site" htmlFor="desc" required className="sm:col-span-2" hint="What you publish, who it is for, and how often it is updated."><Textarea id="desc" required minLength={20} rows={4} value={f.description} onChange={(x) => setF({ ...f, description: x.target.value })} /></Field>
        <Field label="Main traffic sources" htmlFor="ts" className="sm:col-span-2" hint="For example search, newsletter, social. Paid or incentivized traffic must be disclosed."><Input id="ts" value={f.trafficSources} onChange={(x) => setF({ ...f, trafficSources: x.target.value })} /></Field>
        {e && (
          <div className="rounded-xl bg-surface-2 p-4 text-sm sm:col-span-2">
            <p className="mb-2 font-medium">Review checks</p>
            <ul className="list-disc space-y-1 pl-5 text-fg-2">
              {e.requireOriginalContent && <li>Original content that you have the right to publish</li>}
              {e.requirePrivacyPolicy && <li>A privacy policy that discloses advertising</li>}
              {e.requireContactInformation && <li>Clear contact information</li>}
              {e.requireTrafficIntegrity && <li>No bought, incentivized or automated traffic</li>}
              {e.prohibitedContent.slice(0, 5).map((p) => <li key={p}>No {p.toLowerCase()}</li>)}
            </ul>
          </div>
        )}
        <div className="sm:col-span-2">
          <Checkbox checked={accept} onChange={setAccept} label={<>I accept the <a href="/policies/publishers" target="_blank" className="text-primary underline">publisher policies</a> (version {s.policyVersion}) and confirm the information above is accurate.</>} />
        </div>
        <div className="sm:col-span-2"><Button type="submit" loading={busy} disabled={!accept}>Submit for review</Button></div>
      </form>
    </Card>
  );
}

const POSITIONS = ['header', 'sidebar', 'in_content', 'footer', 'other'];

export function PlacementsPanel({ orgId, siteId }: { orgId: string; siteId: string }) {
  const res = useApi<{ data: any[] }>(`/orgs/${orgId}/sites/${siteId}/units`);
  const [edit, setEdit] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    if (!edit) return;
    setBusy(true);
    setError(null);
    const body = { name: edit.name, formats: edit.formats, responsive: edit.responsive, width: edit.responsive ? null : Number(edit.width) || null, height: edit.responsive ? null : Number(edit.height) || null, position: edit.position };
    try {
      if (edit.id) await patch(`/orgs/${orgId}/units/${edit.id}`, body);
      else await post(`/orgs/${orgId}/sites/${siteId}/units`, { ...body, key: edit.key });
      setEdit(null);
      res.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Placements" description="Each placement is a slot on your pages where an ad can appear." actions={<Button size="sm" onClick={() => setEdit({ key: '', name: '', formats: ['image', 'text'], responsive: true, width: '', height: '', position: 'in_content' })}><Plus className="size-4" /> Add placement</Button>} />
      <Async res={res}>
        {({ data }) => <Table rows={data} rowKey={(r) => r.id} empty="No placements yet. Add one to get an ad tag." columns={[
          { key: 'n', header: 'Name', cell: (r) => <span className="font-medium">{r.name}</span> },
          { key: 'k', header: 'Slot key', cell: (r) => <code className="text-xs">{r.key}</code> },
          { key: 'f', header: 'Formats', cell: (r) => r.formats.map(humanize).join(', ') },
          { key: 's', header: 'Size', cell: (r) => (r.responsive ? 'Responsive' : `${r.width}×${r.height}`) },
          { key: 'p', header: 'Position', cell: (r) => humanize(r.position) },
          { key: 'st', header: 'Status', cell: (r) => <span className="flex gap-1"><StatusBadge status={r.status} />{r.adminBlocked && <Badge tone="danger">Blocked by network</Badge>}</span> },
          { key: 'a', header: '', cell: (r) => r.status !== 'archived' && (
            <span className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setEdit({ ...r, width: r.width ?? '', height: r.height ?? '' })}>Edit</Button>
              <Button size="sm" variant="ghost" onClick={async () => { try { await patch(`/orgs/${orgId}/units/${r.id}`, { status: r.status === 'active' ? 'paused' : 'active' }); res.reload(); } catch (e) { setError(errorMessage(e)); } }}>{r.status === 'active' ? 'Pause' : 'Activate'}</Button>
            </span>
          ) },
        ]} />}
      </Async>
      {error && !edit && <Alert tone="danger" className="mt-3">{error}</Alert>}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit placement' : 'New placement'} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button type="submit" form="unit" loading={busy}>Save</Button></>}>
        {edit && (
          <form id="unit" onSubmit={save} className="space-y-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Name" htmlFor="un" required><Input id="un" required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Sidebar top" /></Field>
            {!edit.id && <Field label="Slot key" htmlFor="uk" required hint="Used in the ad tag. Lowercase letters, numbers, hyphens and underscores."><Input id="uk" required pattern="^[a-z0-9][a-z0-9_-]{1,63}$" value={edit.key} onChange={(e) => setEdit({ ...edit, key: e.target.value })} placeholder="sidebar-top" /></Field>}
            <fieldset><legend className="mb-2 text-sm font-medium">Allowed formats</legend><div className="flex gap-4">{['image', 'text', 'native'].map((f) => <Checkbox key={f} label={humanize(f)} checked={edit.formats.includes(f)} onChange={(v) => setEdit({ ...edit, formats: v ? [...edit.formats, f] : edit.formats.filter((x: string) => x !== f) })} />)}</div></fieldset>
            <Checkbox label="Responsive (fits the container width)" checked={edit.responsive} onChange={(v) => setEdit({ ...edit, responsive: v })} />
            {!edit.responsive && <div className="grid grid-cols-2 gap-3"><Field label="Width (px)" htmlFor="uw"><Input id="uw" type="number" min={1} value={edit.width} onChange={(e) => setEdit({ ...edit, width: e.target.value })} /></Field><Field label="Height (px)" htmlFor="uh"><Input id="uh" type="number" min={1} value={edit.height} onChange={(e) => setEdit({ ...edit, height: e.target.value })} /></Field></div>}
            <Field label="Position on the page" htmlFor="up"><Select id="up" value={edit.position} onChange={(e) => setEdit({ ...edit, position: e.target.value })}>{POSITIONS.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</Select></Field>
          </form>
        )}
      </Modal>
    </Card>
  );
}

export function TagPanel({ orgId, siteId }: { orgId: string; siteId: string }) {
  const res = useApi<{ data: any }>(`/orgs/${orgId}/sites/${siteId}/tag`);
  return (
    <Async res={res}>
      {({ data }) => !data.available ? (
        <Card><CardHeader title="Ad tag" /><p className="text-sm text-muted">{data.reason}</p></Card>
      ) : (
        <div className="space-y-5">
          <Card>
            <CardHeader title="Install the ad tag" description={<ul className="mt-1 list-disc space-y-0.5 pl-5">{(data.instructions as string[]).map((i) => <li key={i}>{i}</li>)}</ul>} />
            {data.units.length === 0 ? <p className="text-sm text-muted">Add a placement to get its snippet.</p> : (
              <div className="space-y-4">
                {data.units.map((u: any) => (
                  <div key={u.key}>
                    <p className="mb-1.5 flex items-center gap-2 text-sm font-medium"><CheckCircle2 className="size-4 text-success" /> {u.name} <code className="text-xs text-muted">{u.key}</code></p>
                    <CodeBlock code={u.snippet} label="Paste where the ad should appear" />
                  </div>
                ))}
              </div>
            )}
          </Card>
          {data.consentNote && <Alert tone="info" title="Consent">{data.consentNote}</Alert>}
        </div>
      )}
    </Async>
  );
}

const ADS_TXT_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { found: 'success', missing: 'warning', mismatch: 'warning', error: 'danger', unchecked: 'neutral' };
const ADS_TXT_LABEL: Record<string, string> = { found: 'Line found', missing: 'Line missing', mismatch: 'Line needs fixing', error: 'Could not check', unchecked: 'Not checked yet' };

/** The ads.txt line for this site, and a check that the publisher has added it. */
export function AdsTxtPanel({ orgId, siteId }: { orgId: string; siteId: string }) {
  const res = useApi<{ data: any }>(`/orgs/${orgId}/sites/${siteId}/ads-txt`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function check() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ data: any }>(`/orgs/${orgId}/sites/${siteId}/ads-txt/check`);
      res.setData(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader title="ads.txt" description="Add this line to the ads.txt file at the root of your site. It tells buyers that BlissNova is authorized to sell your ad space, and many buyers skip sites without it."
        actions={<Button size="sm" variant="secondary" loading={busy} onClick={check}><RefreshCw className="size-4" /> Check now</Button>} />
      <Async res={res}>
        {({ data }) => (
          <div className="space-y-3">
            <CodeBlock code={data.line} label={`Add to ${data.adsTxtUrl}`} />
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={ADS_TXT_TONE[data.status] ?? 'neutral'}>{ADS_TXT_LABEL[data.status] ?? data.status}</Badge>
              {data.detail && <span className="text-muted">{data.detail}</span>}
              {data.checkedAt && <span className="text-xs text-muted">Checked {timeAgo(data.checkedAt)}</span>}
            </p>
            <p className="text-xs text-muted">Your seller id <code>{data.sellerId}</code> is listed in the network&apos;s <a className="text-primary hover:underline" href={data.sellersJsonUrl} target="_blank" rel="noreferrer">sellers.json</a>. If ads.txt does not exist yet, create a plain-text file with this line.</p>
            {error && <Alert tone="danger">{error}</Alert>}
          </div>
        )}
      </Async>
    </Card>
  );
}
