'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Bitcoin, Building2, Lock, Wallet } from 'lucide-react';
import { CRYPTO_ASSETS, CRYPTO_NETWORKS, payoutDetailsSchema, type CryptoAsset, type PayoutMethod as Method } from '@blissnova/shared';
import { Alert, Async, Badge, Button, Card, CardHeader, Checkbox, Field, Input, Modal, Select, cn } from '@/components/ui';
import { useApi } from '@/lib/hooks';
import { ApiError, errorMessage, put } from '@/lib/api';
import { formatDate, humanize } from '@/lib/format';

interface Profile { method: string; display_label: string; auto_payout: boolean; masked: Record<string, string> | null; needs_update: boolean; details_changed_at: string | null; updated_at: string }

const METHODS: Array<{ id: Method; label: string; hint: string; icon: ReactNode }> = [
  { id: 'paypal', label: 'PayPal', hint: 'Fastest. Paid to your PayPal email.', icon: <Wallet className="size-5" /> },
  { id: 'bank_transfer', label: 'Bank transfer', hint: 'IBAN, or account number and bank code.', icon: <Building2 className="size-5" /> },
  { id: 'crypto', label: 'Crypto', hint: 'USDT, USDC or BTC to your wallet.', icon: <Bitcoin className="size-5" /> },
];

const LABELS: Record<string, string> = { email: 'PayPal email', accountHolder: 'Account holder', bankName: 'Bank', country: 'Country', iban: 'IBAN', accountNumber: 'Account number', swift: 'SWIFT/BIC', asset: 'Asset', network: 'Network', address: 'Wallet address', memo: 'Memo / tag' };

type Draft = Record<string, string>;

function blank(method: Method): Draft {
  if (method === 'paypal') return { method, email: '' };
  if (method === 'bank_transfer') return { method, accountHolder: '', bankName: '', country: '', iban: '', accountNumber: '', routingNumber: '', swift: '' };
  return { method, asset: 'USDT', network: 'tron', address: '', memo: '' };
}

export function PayoutMethodCard({ orgId, allowed, autoPayoutDay, canEdit }: { orgId: string; allowed: Method[]; autoPayoutDay: number; canEdit: boolean }) {
  const res = useApi<{ data: Profile | null }>(`/orgs/${orgId}/payout-profile`);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [auto, setAuto] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const methods = METHODS.filter((m) => allowed.includes(m.id));

  function open() {
    const cur = res.data?.data;
    setDraft(blank((cur && allowed.includes(cur.method as Method) ? cur.method : methods[0]?.id ?? 'paypal') as Method));
    setAuto(cur?.auto_payout ?? false);
    setErrors({});
    setError(null);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const parsed = payoutDetailsSchema.safeParse(draft);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? 'form'), i.message])));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await put(`/orgs/${orgId}/payout-profile`, { details: draft, autoPayout: auto });
      setDraft(null);
      res.reload();
    } catch (err) {
      const d = err instanceof ApiError && Array.isArray(err.details) ? (err.details as Array<{ path: string; message: string }>) : [];
      if (d.length) setErrors(Object.fromEntries(d.map((x) => [x.path.split('.').pop() ?? 'form', x.message])));
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (k: string) => (v: string) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const field = (k: string, label: string, opts: { hint?: string; placeholder?: string; required?: boolean; mono?: boolean; autoComplete?: string } = {}) => (
    <Field label={label} htmlFor={`po-${k}`} hint={opts.hint} error={errors[k]} required={opts.required}>
      <Input id={`po-${k}`} value={draft?.[k] ?? ''} placeholder={opts.placeholder} autoComplete={opts.autoComplete ?? 'off'} className={opts.mono ? 'font-mono text-xs' : undefined} onChange={(e) => set(k)(e.target.value)} />
    </Field>
  );

  return (
    <Card>
      <CardHeader title="Payout method" description="Where we send your earnings. Details are encrypted and only finance staff can see them in full."
        actions={canEdit && <Button size="sm" variant="secondary" onClick={open}>{res.data?.data ? 'Change' : 'Set up'}</Button>} />
      <Async res={res}>
        {({ data }) => !data ? <p className="text-sm text-muted">No payout method yet. Add one to request payouts.</p> : (
          <div className="space-y-3 text-sm">
            <p className="flex flex-wrap items-center gap-2 font-medium">{data.display_label}{data.auto_payout && <Badge tone="info">Monthly payouts on</Badge>}</p>
            {data.masked && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                {Object.entries(data.masked).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{LABELS[k] ?? humanize(k)}</dt><dd className="font-mono text-xs leading-5">{v}</dd></div>)}
              </dl>
            )}
            {data.needs_update && <Alert tone="warning">This payout method was saved before full details were collected. Update it so payouts can be sent.</Alert>}
            <p className="flex items-center gap-1.5 text-xs text-muted"><Lock className="size-3.5" /> Updated {formatDate(data.updated_at)}. Every change is emailed to the account owners.</p>
          </div>
        )}
      </Async>
      <Modal open={!!draft} onClose={() => setDraft(null)} title="Payout method" footer={<><Button variant="secondary" onClick={() => setDraft(null)}>Cancel</Button><Button type="submit" form="payout-method" loading={busy}>Save payout method</Button></>}>
        {draft && (
          <form id="payout-method" onSubmit={save} className="space-y-4" noValidate>
            {error && <Alert tone="danger">{error}</Alert>}
            <div role="radiogroup" aria-label="Payout method" className="grid gap-2 sm:grid-cols-3">
              {methods.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={draft.method === m.id} onClick={() => { setDraft(blank(m.id)); setErrors({}); }}
                  className={cn('flex flex-col items-start gap-1 rounded-xl border p-3 text-left text-sm transition-colors', draft.method === m.id ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-2')}>
                  <span className={cn('flex items-center gap-2 font-medium', draft.method === m.id && 'text-primary')}>{m.icon}{m.label}</span>
                  <span className="text-xs text-muted">{m.hint}</span>
                </button>
              ))}
            </div>
            {draft.method === 'paypal' && field('email', 'PayPal email', { required: true, placeholder: 'you@example.com', autoComplete: 'email', hint: 'The email of the PayPal account that should receive payouts.' })}
            {draft.method === 'bank_transfer' && (
              <div className="grid gap-4 sm:grid-cols-2">
                {field('accountHolder', 'Account holder name', { required: true, autoComplete: 'name' })}
                {field('bankName', 'Bank name', { required: true })}
                {field('country', 'Bank country', { required: true, placeholder: 'NG, GB, US…', hint: 'Two-letter code.' })}
                {field('swift', 'SWIFT/BIC', { placeholder: 'GTBINGLA', hint: 'Needed for international transfers.' })}
                {field('iban', 'IBAN', { placeholder: 'GB29 NWBK 6016 1331 9268 19', mono: true, hint: 'Europe, UK and other IBAN countries.' })}
                {field('accountNumber', 'Account number', { mono: true, hint: 'If your bank has no IBAN.' })}
                {field('routingNumber', 'Routing number / sort code / bank code', { mono: true, hint: 'US routing number, UK sort code, or local code.' })}
              </div>
            )}
            {draft.method === 'crypto' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Asset" htmlFor="po-asset" required>
                  <Select id="po-asset" value={draft.asset} onChange={(e) => { const a = e.target.value as CryptoAsset; setDraft({ ...draft, asset: a, network: CRYPTO_ASSETS[a][0] }); }}>
                    {Object.keys(CRYPTO_ASSETS).map((a) => <option key={a} value={a}>{a}</option>)}
                  </Select>
                </Field>
                <Field label="Network" htmlFor="po-network" required error={errors.network} hint="Must match the network your wallet or exchange deposit address uses.">
                  <Select id="po-network" value={draft.network} onChange={(e) => set('network')(e.target.value)}>
                    {CRYPTO_ASSETS[(draft.asset as CryptoAsset) ?? 'USDT'].map((n) => <option key={n} value={n}>{CRYPTO_NETWORKS[n].label}</option>)}
                  </Select>
                </Field>
                <div className="sm:col-span-2">{field('address', 'Wallet address', { required: true, mono: true })}</div>
                {field('memo', 'Memo / tag (optional)', { hint: 'Only if your exchange asks for one.' })}
                <div className="sm:col-span-2"><Alert tone="warning">Crypto transfers cannot be reversed. Sending to the wrong network loses the funds, so double-check the address and network.</Alert></div>
              </div>
            )}
            <Checkbox label="Request my payout automatically each month" checked={auto} onChange={setAuto}
              hint={autoPayoutDay ? `On day ${autoPayoutDay} of each month (UTC), if your available balance reaches the minimum. Finance still reviews every payout.` : 'Automatic monthly payouts are currently turned off by the network.'} />
          </form>
        )}
      </Modal>
    </Card>
  );
}
