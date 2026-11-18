'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Async, Badge, Button, Card, CardHeader, DefinitionList, Field, Input, PageHeader, Select, StatusBadge } from '@/components/ui';
import { AdminTable } from '@/components/admin/kit';
import { useApi } from '@/lib/hooks';
import { errorMessage, post, put } from '@/lib/api';
import { formatDate, humanize, timeAgo } from '@/lib/format';
import { COUNTRIES, countryLabel } from '@/lib/countries';

interface GeoStatus {
  header: string | null;
  database: { path: string; description: string | null; fileDate: string | null; attribution: { text: string; url: string } | null } | null;
  autoUpdate: { enabled: boolean; source: string; lastCheckAt: string | null; lastResult: string | null; lastError: string | null; nextCheckAt: string | null };
  localTestCountry: string | null;
  localTestAllowed: boolean;
}

const SOURCE_LABEL: Record<string, string> = { header: 'CDN country header', database: 'GeoIP database', local_test: 'Local test country (development)', unknown: 'Unknown' };

/** How visitor countries are found, with an IP lookup and (in development) a test country for local visits. */
function VisitorLocation({ initial, onChange }: { initial: GeoStatus; onChange: () => void }) {
  const [g, setG] = useState(initial);
  const [ip, setIp] = useState('');
  const [hit, setHit] = useState<{ ip: string; country: string; source: string } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const db = g.database;
  async function lookup(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try { setHit((await post<{ data: { ip: string; country: string; source: string } }>('/admin/geo/lookup', { ip: ip.trim() })).data); } catch (err) { setHit(null); setMsg({ tone: 'danger', text: errorMessage(err) }); }
  }
  async function update() {
    setBusy(true); setMsg(null);
    try {
      const r = (await post<{ data: { updated: boolean; message: string; status: GeoStatus } }>('/admin/geo/update')).data;
      setG(r.status); setMsg({ tone: r.updated ? 'success' : 'info', text: r.message }); onChange();
    } catch (err) { setMsg({ tone: 'danger', text: errorMessage(err) }); } finally { setBusy(false); }
  }
  async function setLocal(country: string) {
    try { setG((await put<{ data: GeoStatus }>('/admin/geo/local-country', { country })).data); setMsg({ tone: 'success', text: country ? `Visits from this computer now count as ${countryLabel(country)}.` : 'Visits from this computer count as unknown again.' }); } catch (err) { setMsg({ tone: 'danger', text: errorMessage(err) }); }
  }
  return (
    <Card>
      <CardHeader title="Visitor location" description="Country targeting and country reports use the CDN's country header when there is one, else the GeoIP database on this server."
        actions={db?.description ? <Badge tone="success">Database loaded</Badge> : g.header ? <Badge tone="success">Header</Badge> : <Badge tone="warning">Countries unknown</Badge>} />
      {msg && <Alert tone={msg.tone} className="mb-4">{msg.text}</Alert>}
      <DefinitionList items={[
        ['Country header', g.header ? <code key="h" className="text-xs">{g.header}</code> : 'Not configured (set GEO_COUNTRY_HEADER behind a CDN such as Cloudflare: cf-ipcountry)'],
        ['GeoIP database', db?.description ?? (db ? 'Not downloaded yet' : 'Not configured (set GEOIP_DB_PATH)')],
        ...(db ? [['File', <span key="f" className="break-all text-xs">{db.path}{db.fileDate ? ` · saved ${formatDate(db.fileDate, true)}` : ''}</span>] as [string, ReactNode]] : []),
        ['Monthly update', g.autoUpdate.enabled ? `On, from ${g.autoUpdate.source}${g.autoUpdate.lastCheckAt ? ` · checked ${timeAgo(g.autoUpdate.lastCheckAt)}` : ''}` : 'Off (set GEOIP_AUTO_UPDATE=true)'],
        ...(g.autoUpdate.lastResult ? [['Last check', <span key="l" className={g.autoUpdate.lastError ? 'text-danger' : ''}>{g.autoUpdate.lastResult}{g.autoUpdate.lastError ? ` (${g.autoUpdate.lastError})` : ''}</span>] as [string, ReactNode]] : []),
      ]} />
      {db && <div className="mt-3"><Button size="sm" variant="secondary" loading={busy} onClick={update}>Update database now</Button></div>}

      <form onSubmit={lookup} className="mt-5 flex flex-wrap items-end gap-3 border-t border-border pt-4">
        <Field label="Look up an IP address" htmlFor="geo-ip"><Input id="geo-ip" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="81.2.69.160" className="w-56" /></Field>
        <Button type="submit" variant="secondary">Look up</Button>
        {hit && <p className="pb-2 text-sm" data-testid="geo-lookup-result"><span className="font-medium text-fg">{countryLabel(hit.country)}</span> {hit.country !== 'ZZ' && <code className="text-xs">{hit.country}</code>} <span className="text-muted">· {SOURCE_LABEL[hit.source] ?? hit.source}</span></p>}
      </form>

      {g.localTestAllowed && (
        <div className="mt-5 border-t border-border pt-4">
          <Field label="Test country for local visits" htmlFor="geo-local" hint="Development only. Visits from this computer or your home network have no public address, so they count as this country to try country targeting. Resets when the API restarts unless GEO_LOCAL_COUNTRY is set.">
            <Select id="geo-local" value={g.localTestCountry ?? ''} onChange={(e) => void setLocal(e.target.value)} className="max-w-xs">
              <option value="">Unknown (default)</option>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </Select>
          </Field>
        </div>
      )}
      {db?.attribution && <p className="mt-4 text-xs text-muted"><a href={db.attribution.url} className="underline" target="_blank" rel="noreferrer">{db.attribution.text}</a> (free database, CC BY 4.0).</p>}
    </Card>
  );
}

export default function System() {
  const res = useApi<{ data: any }>('/admin/system');
  return (
    <>
      <PageHeader title="System health" description="Services, background jobs, migrations and integrations for this installation." />
      <Async res={res}>
        {({ data: d }) => (
          <div className="space-y-5">
            <div className="grid gap-5 lg:grid-cols-2">
              <Card>
                <CardHeader title="Services" />
                <DefinitionList items={[
                  ['Environment', <Badge key="e" tone={d.environment === 'production' ? 'success' : 'warning'}>{d.environment}</Badge>],
                  ['Database', <Badge key="d" tone={d.health.database === 'ok' ? 'success' : 'danger'}>{d.health.database}</Badge>],
                  ['Redis', <Badge key="r" tone={d.health.redis === 'ok' ? 'success' : 'danger'}>{d.health.redis}</Badge>],
                  ['Worker', d.health.worker.lastHeartbeat ? `Last heartbeat ${timeAgo(d.health.worker.lastHeartbeat)}` : d.eventProcessing === 'inline' ? 'Inline processing (no worker needed)' : 'No heartbeat'],
                  ['Event processing', humanize(d.eventProcessing)], ['Public site URL', d.publicUrls.site], ['Public API URL', d.publicUrls.api], 
                  ['Email', `${d.email.provider}${d.email.configured ? '' : ' (not configured)'}`],
                ]} />
              </Card>
              <Card>
                <CardHeader title="Queues" />
                <table className="w-full text-sm"><thead><tr className="text-left text-xs text-muted"><th className="py-1">Queue</th><th>Waiting</th><th>Active</th><th>Failed</th><th>Done</th></tr></thead>
                  <tbody>{Object.entries(d.health.queues as Record<string, any>).map(([n, q]) => <tr key={n} className="border-t border-border"><td className="py-1.5">{humanize(n)}</td>{typeof q === 'string' ? <td colSpan={4} className="text-muted">{q}</td> : <><td>{q.waiting}</td><td>{q.active}</td><td className={q.failed ? 'text-danger' : ''}>{q.failed}</td><td>{q.completed}</td></>}</tr>)}</tbody>
                </table>
              </Card>
              <VisitorLocation initial={d.geo} onChange={res.reload} />
              <Card>
                <CardHeader title="Payment providers" />
                <ul className="space-y-1 text-sm">{d.payments.map((p: any) => <li key={p.id} className="flex items-center gap-2"><Badge tone={p.configured ? 'success' : 'neutral'}>{p.configured ? 'Configured' : 'Off'}</Badge>{p.label}{p.id === 'dev_simulated' && <Badge tone="warning">Development only</Badge>}</li>)}</ul>
              </Card>
              <Card>
                <CardHeader title="Database migrations" />
                <ul className="space-y-1 text-sm">{d.migrations.map((m: any) => <li key={m.id} className="flex items-center gap-2"><Badge tone={m.applied ? 'success' : 'danger'}>{m.applied ? 'Applied' : 'Pending'}</Badge><code className="text-xs">{m.id}</code></li>)}</ul>
              </Card>
            </div>
            <div>
              <h2 className="mb-3 font-semibold">Email outbox</h2>
              <AdminTable<any> path="/admin/email-outbox" search={false} statuses={['pending', 'sent', 'failed']} rowKey={(r) => r.id} columns={[
                { key: 'w', header: 'Created', cell: (r) => formatDate(r.created_at, true) }, { key: 't', header: 'To', cell: (r) => r.to_address }, { key: 's', header: 'Subject', cell: (r) => r.subject },
                { key: 'st', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> }, { key: 'e', header: 'Error', cell: (r) => <span className="text-xs text-danger">{r.last_error ?? ''}</span> },
              ]} />
            </div>
          </div>
        )}
      </Async>
    </>
  );
}
