'use client';
import { useState, type FormEvent } from 'react';
import { Upload } from 'lucide-react';
import { Alert, Button, Field, Input, Modal, Select, Textarea } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useConfig } from '@/lib/hooks';

export interface Creative {
  id: string; name: string; format: 'image' | 'text' | 'native' | 'pop'; status: string; version: number; approvedVersion: number | null;
  headline: string | null; body: string | null; cta: string | null; assetId: string | null; imageUrl: string | null;
  width: number | null; height: number | null; destinationUrl: string; displayUrl: string | null; altText: string | null; sponsorName?: string | null; rejectionReason: string | null;
}

/** Visual preview of a creative as it renders in a slot, with the ad label the SDK adds. */
export function CreativePreview({ c }: { c: Pick<Creative, 'format' | 'headline' | 'body' | 'cta' | 'imageUrl' | 'width' | 'height' | 'altText' | 'displayUrl' | 'sponsorName'> & { sponsor_name?: string | null; destinationUrl?: string | null; destination_url?: string | null } }) {
  if (c.format === 'pop') {
    const url = c.destinationUrl ?? c.destination_url ?? '';
    let host = '';
    try { host = new URL(url).hostname; } catch { /* not a URL yet */ }
    return (
      <div className="w-72 max-w-full overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
        <div className="flex items-center gap-1.5 border-b border-border bg-surface-2 px-2 py-1.5">
          <span className="size-2 rounded-full bg-border-strong" /><span className="size-2 rounded-full bg-border-strong" /><span className="size-2 rounded-full bg-border-strong" />
          <span className="ml-2 truncate rounded bg-surface px-2 py-0.5 text-[11px] text-muted">{url || 'https://'}</span>
        </div>
        <div className="flex h-28 flex-col items-center justify-center gap-1 px-3 text-center">
          <p className="text-sm font-semibold text-fg">{host || 'Your landing page'}</p>
          <p className="text-xs text-muted">Opens in a new tab after the visitor clicks on the publisher's page</p>
        </div>
      </div>
    );
  }
  if (c.format === 'native') {
    const sponsor = c.sponsorName ?? c.sponsor_name;
    return (
      <div className="w-72 max-w-full overflow-hidden rounded-lg border border-border bg-surface">
        {c.imageUrl ? <img src={c.imageUrl} alt={c.altText ?? ''} className="aspect-[1.91/1] w-full object-cover" /> : <div className="flex aspect-[1.91/1] items-center justify-center bg-surface-2 text-xs text-muted">No image</div>}
        <div className="p-3">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Sponsored{sponsor ? ` · ${sponsor}` : ''}</p>
          <p className="font-semibold text-fg">{c.headline || 'Headline'}</p>
          {c.body && <p className="mt-0.5 text-sm text-fg-2">{c.body}</p>}
          <div className="mt-2 flex items-center justify-between gap-2 text-xs">
            <span className="truncate text-muted">{c.displayUrl}</span>
            {c.cta && <span className="font-semibold text-primary">{c.cta}</span>}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="inline-block max-w-full rounded-lg border border-border bg-surface p-2">
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">Ad</p>
      {c.format === 'image' ? (
        c.imageUrl ? <img src={c.imageUrl} alt={c.altText ?? ''} width={c.width ?? undefined} height={c.height ?? undefined} className="h-auto max-w-full" /> : <div className="flex h-24 w-48 items-center justify-center bg-surface-2 text-xs text-muted">No image</div>
      ) : (
        <div className="w-72 max-w-full">
          <p className="font-semibold text-fg">{c.headline || 'Headline'}</p>
          {c.body && <p className="mt-0.5 text-sm text-fg-2">{c.body}</p>}
          <div className="mt-2 flex items-center justify-between gap-2 text-xs">
            <span className="truncate text-muted">{c.displayUrl}</span>
            {c.cta && <span className="rounded-md bg-primary px-2 py-1 font-medium text-primary-fg">{c.cta}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Create or edit a creative. Image creatives upload the file first, then reference the stored asset. */
export function CreativeEditor({ open, onClose, orgId, campaignId, creative, onSaved, pricingModel }: { open: boolean; onClose: () => void; orgId: string; campaignId: string; creative?: Creative | null; onSaved: () => void; pricingModel?: string }) {
  const cfg = useConfig().data?.data;
  const editing = !!creative;
  const [f, setF] = useState({
    name: creative?.name ?? '', format: (creative?.format ?? 'image') as Creative['format'], headline: creative?.headline ?? '', body: creative?.body ?? '',
    cta: creative?.cta ?? '', destinationUrl: creative?.destinationUrl ?? 'https://', displayUrl: creative?.displayUrl ?? '', altText: creative?.altText ?? '',
    sponsorName: creative?.sponsorName ?? '',
  });
  const needsImage = f.format === 'image' || f.format === 'native';
  const [asset, setAsset] = useState<{ id: string; url: string; width: number; height: number } | null>(creative?.assetId && creative.imageUrl ? { id: creative.assetId, url: creative.imageUrl, width: creative.width ?? 0, height: creative.height ?? 0 } : null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  async function upload(file: File) {
    setError(null);
    if (cfg && file.size > cfg.creatives.maxUploadBytes) return setError(`The file is larger than the ${Math.round(cfg.creatives.maxUploadBytes / 1000)} KB limit.`);
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await api<{ data: { id: string; url: string; width: number; height: number } }>('POST', `/orgs/${orgId}/assets`, { form });
      setAsset(r.data);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const body: Record<string, unknown> = {
      name: f.name, destinationUrl: f.destinationUrl, displayUrl: f.displayUrl || undefined,
      ...(f.format === 'image' ? { assetId: asset?.id, altText: f.altText || undefined } : f.format === 'pop' ? {} : { headline: f.headline, body: f.body || undefined, cta: f.cta || undefined }),
      ...(f.format === 'native' ? { assetId: asset?.id, altText: f.altText || undefined, sponsorName: f.sponsorName } : {}),
    };
    try {
      if (editing) await api('PATCH', `/orgs/${orgId}/creatives/${creative!.id}`, { body });
      else await api('POST', `/orgs/${orgId}/campaigns/${campaignId}/creatives`, { body: { ...body, format: f.format } });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} wide title={editing ? 'Edit creative' : 'New creative'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="creative-form" loading={busy} disabled={needsImage && !asset}>{editing ? 'Save changes' : 'Add creative'}</Button></>}>
      <form id="creative-form" onSubmit={save} className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          {editing && creative?.status === 'approved' && <Alert tone="info">Changing an approved creative sends the new version for review. The approved version keeps serving until the change is approved.</Alert>}
          <Field label="Name" htmlFor="cn" required hint="Only you and reviewers see this."><Input id="cn" required maxLength={160} value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
          {!editing && (
            <Field label="Format" htmlFor="cf">
              <Select id="cf" value={f.format} onChange={(e) => set('format', e.target.value)}>
                {(!cfg || cfg.creatives.allowedFormats.includes('image')) && <option value="image">Image banner</option>}
                {(!cfg || cfg.creatives.allowedFormats.includes('text')) && <option value="text">Text ad</option>}
                {(!cfg || cfg.creatives.allowedFormats.includes('native')) && <option value="native">Native ad (image, headline and sponsor)</option>}
                {(!cfg || cfg.creatives.allowedFormats.includes('pop')) && pricingModel !== 'cpc' && <option value="pop">Pop traffic (your page opens in a new tab)</option>}
              </Select>
            </Field>
          )}
          {f.format === 'pop' && <Alert tone="info" title="How pop ads work">Your landing page opens in a new tab when a visitor clicks on a publisher's page that has a pop placement. Pops are sold per thousand (CPM), never per click, and are capped per visitor. Reviewers check the landing page before it runs.</Alert>}
          {needsImage && (
            <>
              <Field label="Image" htmlFor="ci" hint={cfg ? `${cfg.creatives.allowedImageTypes.map((t) => t.replace('image/', '').toUpperCase()).join(', ')}, up to ${Math.round(cfg.creatives.maxUploadBytes / 1000)} KB. Animated and scripted files are rejected.` : undefined}>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border-strong px-3 py-3 text-sm text-fg-2 hover:bg-surface-2">
                  <Upload className="size-4" /> {uploading ? 'Uploading…' : asset ? `Replace image (${asset.width}×${asset.height})` : 'Choose an image'}
                  <input id="ci" type="file" className="sr-only" accept={cfg?.creatives.allowedImageTypes.join(',') ?? 'image/*'} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
                </label>
              </Field>
              <Field label="Alternative text" htmlFor="alt" hint="Describes the image for screen readers."><Input id="alt" maxLength={200} value={f.altText} onChange={(e) => set('altText', e.target.value)} /></Field>
            </>
          )}
          {f.format === 'native' && (
            <Field label="Sponsor name" htmlFor="sp" required hint={'Shown to readers as "Sponsored · name" above the headline, so the ad is never mistaken for editorial content.'}><Input id="sp" required maxLength={60} value={f.sponsorName} onChange={(e) => set('sponsorName', e.target.value)} /></Field>
          )}
          {f.format !== 'image' && f.format !== 'pop' && (
            <>
              <Field label="Headline" htmlFor="hl" required><Input id="hl" required maxLength={90} value={f.headline} onChange={(e) => set('headline', e.target.value)} /></Field>
              <Field label="Body" htmlFor="bd"><Textarea id="bd" maxLength={200} rows={2} value={f.body} onChange={(e) => set('body', e.target.value)} /></Field>
              <Field label="Call to action" htmlFor="cta"><Input id="cta" maxLength={30} value={f.cta} onChange={(e) => set('cta', e.target.value)} placeholder="Learn more" /></Field>
            </>
          )}
          <Field label={f.format === 'pop' ? 'Landing page URL' : 'Destination URL'} htmlFor="du" required hint={f.format === 'pop' ? 'The page that opens. Must be a secure https link.' : 'Where a click goes. Must be a secure https link.'}><Input id="du" type="url" required value={f.destinationUrl} onChange={(e) => set('destinationUrl', e.target.value)} /></Field>
          {f.format !== 'pop' && <Field label="Display URL" htmlFor="dsp" hint="Optional, shown on text and native ads."><Input id="dsp" maxLength={100} value={f.displayUrl} onChange={(e) => set('displayUrl', e.target.value)} /></Field>}
        </div>
        <div className="sm:w-80">
          <p className="mb-2 text-sm font-medium">Preview</p>
          <CreativePreview c={{ format: f.format, headline: f.headline, body: f.body, cta: f.cta, imageUrl: asset?.url ?? null, width: asset?.width ?? null, height: asset?.height ?? null, altText: f.altText, displayUrl: f.displayUrl, sponsorName: f.sponsorName, destinationUrl: f.destinationUrl }} />
        </div>
      </form>
    </Modal>
  );
}
