'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Async, Badge, Button, Card, CardHeader, Checkbox, Field, Input, PageHeader, ReasonDialog, Textarea, cn } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { patch } from '@/lib/api';
import { humanize, microsToInput, timeAgo, toMicrosString } from '@/lib/format';

const GROUP_HELP: Record<string, string> = {
  tracking: 'What is measured and for how long raw events are kept.',
  ivt: 'Thresholds for automated invalid-traffic filtering.',
  frequency: 'Network-wide frequency defaults.',
  creatives: 'Accepted creative formats and upload limits.',
  publishers: 'Revenue share, earnings hold and payout minimum.',
  verification: 'Domain verification methods and limits.',
  eligibility: 'Publisher requirements shown publicly and used in review. Thresholds are optional and configurable, never fixed.',
  pricing: 'Enabled pricing models, minimum rates and currencies.',
  api: 'Rate limits.',
  platform: 'Maintenance mode, registration and staff sign-in rules.',
  branding: 'Names, support contact and legal links shown across the site.',
  email: 'Sender details and message templates.',
};

type Draft = Record<string, unknown>;

function label(key: string) {
  return humanize(key.replace(/Micros$/, '').replace(/Bps$/, ' (%)').replace(/([a-z])([A-Z])/g, '$1 $2'));
}

/** Renders an input for one setting based on its current value's shape. */
function SettingInput({ k, value, onChange, disabled }: { k: string; value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  const id = `s-${k}`;
  if (typeof value === 'boolean') return <Checkbox label={label(k)} checked={value} disabled={disabled} onChange={onChange} />;
  if (k.endsWith('Micros')) return <Field label={label(k)} htmlFor={id} hint="Amount in the default currency"><Input id={id} disabled={disabled} inputMode="decimal" defaultValue={microsToInput(value as string)} onBlur={(e) => onChange(toMicrosString(e.target.value) ?? value)} /></Field>;
  if (k.endsWith('Bps')) return <Field label={label(k)} htmlFor={id}><Input id={id} disabled={disabled} type="number" step="0.01" min={0} max={100} defaultValue={Number(value) / 100} onBlur={(e) => onChange(Math.round(Number(e.target.value) * 100))} /></Field>;
  if (typeof value === 'number' || (value === null && /Pageviews|Count|Days|Hours/.test(k))) return <Field label={label(k)} htmlFor={id} hint={value === null ? 'Empty means no requirement' : undefined}><Input id={id} disabled={disabled} type="number" defaultValue={value === null ? '' : String(value)} onBlur={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} /></Field>;
  if (Array.isArray(value) && value.every((x) => typeof x === 'string')) return <Field label={label(k)} htmlFor={id} hint="One per line"><Textarea id={id} disabled={disabled} rows={Math.min(6, Math.max(2, value.length))} defaultValue={value.join('\n')} onBlur={(e) => onChange(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean))} /></Field>;
  if (typeof value === 'string') return <Field label={label(k)} htmlFor={id}>{value.length > 80 || /message|notes/i.test(k) ? <Textarea id={id} disabled={disabled} rows={3} defaultValue={value} onBlur={(e) => onChange(e.target.value)} /> : <Input id={id} disabled={disabled} defaultValue={value} onBlur={(e) => onChange(e.target.value)} />}</Field>;
  return <Field label={label(k)} htmlFor={id} hint="JSON"><Textarea id={id} disabled={disabled} rows={6} className="font-mono text-xs" defaultValue={JSON.stringify(value, null, 2)} onBlur={(e) => { try { onChange(JSON.parse(e.target.value)); } catch { /* keep previous value until valid */ } }} /></Field>;
}

function Settings() {
  const params = useSearchParams();
  const { canAdmin } = useSession();
  const res = useApi<{ data: { settings: Record<string, Draft>; updated: Array<{ key: string; updated_at: string; updated_by: string | null }>; secrets: Record<string, boolean>; groups: string[] } }>('/admin/settings');
  const [group, setGroup] = useState(params.get('group') ?? 'platform');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [resets, setResets] = useState(0);
  const manage = canAdmin('admin:settings:manage');
  return (
    <>
      <PageHeader title="Settings" description="Platform configuration. Every change needs a reason and is recorded in the audit log. Secrets are set in the server environment, never here." />
      <Async res={res}>
        {({ data }) => {
          const current = data.settings[group] ?? {};
          const values = draft ?? current;
          const updated = data.updated.find((u) => u.key === group);
          return (
            <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
              <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Settings groups">
                {data.groups.map((g) => <button key={g} onClick={() => { setGroup(g); setDraft(null); setMsg(null); }} className={cn('whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm', g === group ? 'bg-primary-soft font-medium text-primary' : 'text-fg-2 hover:bg-surface-2')}>{humanize(g)}</button>)}
              </nav>
              <div className="space-y-5">
                <Card>
                  <CardHeader title={humanize(group)} description={<>{GROUP_HELP[group]}{updated && <span className="block text-xs">Last changed {timeAgo(updated.updated_at)}{updated.updated_by ? ` by ${updated.updated_by}` : ''}.</span>}</>} />
                  {msg && <Alert tone="success" className="mb-4">{msg}</Alert>}
                  <div key={`${group}:${resets}`} className="grid gap-4 sm:grid-cols-2">
                    {Object.entries(values).map(([k, v]) => <div key={k} className={typeof v === 'boolean' ? '' : Array.isArray(v) || (typeof v === 'object' && v !== null) ? 'sm:col-span-2' : ''}><SettingInput k={k} value={v} disabled={!manage} onChange={(nv) => setDraft({ ...values, [k]: nv })} /></div>)}
                  </div>
                  {manage && <div className="mt-5 flex gap-2"><Button disabled={!draft} onClick={() => setConfirm(true)}>Save changes</Button>{draft && <Button variant="ghost" onClick={() => { setDraft(null); setResets((n) => n + 1); }}>Discard</Button>}</div>}
                </Card>
                <Card>
                  <CardHeader title="Server configuration" description="Set through environment variables. Shown here as configured or not, never the values." />
                  <div className="flex flex-wrap gap-2">{Object.entries(data.secrets).map(([k, v]) => <Badge key={k} tone={v ? 'success' : 'neutral'}>{humanize(k.replace(/Configured$/, ''))}: {v ? 'configured' : 'not configured'}</Badge>)}</div>
                </Card>
              </div>
              <ReasonDialog open={confirm} onClose={() => setConfirm(false)} title={`Save ${humanize(group)} settings`} confirmLabel="Save"
                onConfirm={async (reason) => { await patch(`/admin/settings/${group}`, { values: draft, reason }); setConfirm(false); setDraft(null); setResets((n) => n + 1); setMsg('Saved.'); res.reload(); }} />
            </div>
          );
        }}
      </Async>
    </>
  );
}

export default function Page() {
  return <Suspense><Settings /></Suspense>;
}
