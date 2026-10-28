'use client';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Archive, Copy, Pause, Pencil, Play, Plus, Send, Trash2 } from 'lucide-react';
import { ADVERTISER_CAMPAIGN_TRANSITIONS, EDITABLE_CAMPAIGN_STATUSES } from '@blissnova/shared';
import { Alert, Async, Badge, Button, Card, CardHeader, DefinitionList, EmptyState, PageHeader, Stat, StatusBadge, Table, Tabs } from '@/components/ui';
import { CampaignForm } from '@/components/advertiser/CampaignForm';
import { CreativeEditor, CreativePreview, type Creative } from '@/components/advertiser/CreativeEditor';
import { ReportExplorer } from '@/components/ReportExplorer';
import { useApi } from '@/lib/hooks';
import { useOrg } from '@/lib/session';
import { ApiError, errorMessage, patch, post } from '@/lib/api';
import { formatDate, formatMicros, formatNumber, humanize, timeAgo } from '@/lib/format';

function CampaignDetail() {
  const org = useOrg();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const [tab, setTab] = useState(search.get('tab') ?? 'overview');
  const res = useApi<{ data: any }>(`/orgs/${org.id}/campaigns/${id}`);
  const creatives = useApi<{ data: Creative[] }>(`/orgs/${org.id}/campaigns/${id}/creatives`);
  const history = useApi<{ data: any[] }>(tab === 'history' ? `/orgs/${org.id}/campaigns/${id}/history` : null);
  const [editor, setEditor] = useState<{ creative: Creative | null } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const money = (v: string | null | undefined) => formatMicros(v, org.currency);

  async function act(action: string) {
    setActionError(null);
    setBusy(action);
    try {
      if (action === 'duplicate') {
        const r = await post<{ data: { id: string } }>(`/orgs/${org.id}/campaigns/${id}/duplicate`);
        router.push(`/advertiser/campaigns/${r.data.id}`);
        return;
      }
      const r = await post<{ data: any }>(`/orgs/${org.id}/campaigns/${id}/${action}`);
      res.setData(r);
      creatives.reload();
    } catch (e) {
      setActionError(e instanceof ApiError && e.status === 402 ? 'Your available balance does not cover this campaign’s lifetime budget. Add funds on the Billing page, then submit again.' : errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Async res={res}>
      {({ data: c }) => {
        const can = (a: string) => ADVERTISER_CAMPAIGN_TRANSITIONS[a]?.includes(c.status);
        const editable = EDITABLE_CAMPAIGN_STATUSES.includes(c.status);
        const pct = Number(c.lifetimeBudgetMicros) > 0 ? Math.min(100, (Number(c.spentMicros) / Number(c.lifetimeBudgetMicros)) * 100) : 0;
        return (
          <>
            <PageHeader
              back={{ href: '/advertiser/campaigns', label: 'Campaigns' }}
              title={<span className="flex flex-wrap items-center gap-2">{c.name} <StatusBadge status={c.status} /></span>}
              description={`${c.pricingModel.toUpperCase()} at ${money(c.rateMicros)}${c.pricingModel === 'cpm' ? ' per 1,000 valid impressions' : c.pricingModel === 'cpc' ? ' per valid click' : ' sponsorship'}`}
              actions={
                <div className="flex flex-wrap gap-2">
                  {can('submit') && <Button onClick={() => act('submit')} loading={busy === 'submit'}><Send className="size-4" /> Submit for review</Button>}
                  {can('pause') && <Button variant="secondary" onClick={() => act('pause')} loading={busy === 'pause'}><Pause className="size-4" /> Pause</Button>}
                  {can('resume') && <Button onClick={() => act('resume')} loading={busy === 'resume'}><Play className="size-4" /> Resume</Button>}
                  <Button variant="secondary" onClick={() => act('duplicate')} loading={busy === 'duplicate'}><Copy className="size-4" /> Duplicate</Button>
                  {can('archive') && <Button variant="ghost" onClick={() => act('archive')} loading={busy === 'archive'}><Archive className="size-4" /> Archive</Button>}
                </div>
              }
            />
            {actionError && <Alert tone="danger" className="mb-4">{actionError}</Alert>}
            {c.status === 'rejected' && c.statusReason && <Alert tone="danger" title="This campaign was not approved" className="mb-4">{c.statusReason} Update it and submit again.</Alert>}
            {c.status === 'suspended' && <Alert tone="danger" title="Suspended by the network" className="mb-4">{c.statusReason ?? 'Contact support for details.'}</Alert>}
            {c.status === 'pending_approval' && <Alert tone="info" className="mb-4">This campaign is waiting for review. Its budget is reserved from your balance and it will not serve until approved.</Alert>}
            {c.status === 'draft' && <Alert tone="info" className="mb-4">Drafts never serve. Add at least one creative, then submit for review.</Alert>}
            <Tabs active={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'creatives', label: `Creatives${creatives.data ? ` (${creatives.data.data.filter((x) => x.status !== 'archived').length})` : ''}` }, { id: 'report', label: 'Report' }, { id: 'settings', label: 'Settings' }, { id: 'history', label: 'History' }]} />
            <div className="mt-5">
              {tab === 'overview' && (
                <div className="space-y-5">
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <Stat label="Spent" value={money(c.spentMicros)} hint={`${pct.toFixed(1)}% of lifetime budget`} />
                    <Stat label="Remaining budget" value={money(c.remainingMicros)} />
                    <Stat label="Billable impressions" value={formatNumber(c.billableImpressions)} />
                    <Stat label="Billable clicks" value={formatNumber(c.billableClicks)} />
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Budget used">
                    <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                  <Card>
                    <CardHeader title="Delivery settings" />
                    <DefinitionList items={[
                      ['Schedule', `${formatDate(c.startAt, true)} – ${c.endAt ? formatDate(c.endAt, true) : 'no end date'} (${c.timezone})`],
                      ['Lifetime budget', money(c.lifetimeBudgetMicros)],
                      ['Daily budget', c.dailyBudgetMicros ? money(c.dailyBudgetMicros) : 'No daily limit'],
                      ['Reserved from balance', money(c.reservedMicros)],
                      ['Pacing', c.pacing === 'even' ? 'Even' : 'As fast as possible'],
                      ['Priority', String(c.priority)],
                      ['Countries', c.targeting?.countries?.length ? c.targeting.countries.join(', ') : 'All'],
                      ['Devices', c.targeting?.devices?.length ? c.targeting.devices.map(humanize).join(', ') : 'All'],
                      ['Site categories', c.targeting?.siteCategories?.length ? c.targeting.siteCategories.join(', ') : 'All'],
                      ['Keywords', c.targeting?.keywords?.length ? c.targeting.keywords.join(', ') : 'None'],
                      ['Personalized only', c.targeting?.requirePersonalized ? 'Yes' : 'No'],
                      ['Frequency caps', c.caps.length ? c.caps.map((x: any) => `${x.maxImpressions} per ${x.scope} per ${Math.round(x.windowSeconds / 3600)}h`).join('; ') : 'None'],
                    ]} />
                  </Card>
                </div>
              )}
              {tab === 'creatives' && (
                <Card>
                  <CardHeader title="Creatives" description="Every new creative and every change is reviewed before it serves." actions={!['archived', 'completed', 'suspended'].includes(c.status) && <Button size="sm" onClick={() => setEditor({ creative: null })}><Plus className="size-4" /> Add creative</Button>} />
                  <Async res={creatives}>
                    {({ data }) => data.length === 0 ? <EmptyState title="No creatives yet">Add an image banner or a text ad. Creatives must follow the creative rules.</EmptyState> : (
                      <div className="grid gap-4 md:grid-cols-2">
                        {data.map((cr) => (
                          <div key={cr.id} className="rounded-xl border border-border p-4">
                            <div className="mb-3 flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate font-medium">{cr.name}</p>
                                <p className="text-xs text-muted">{cr.format === 'image' ? `Image ${cr.width}×${cr.height}` : cr.format === 'native' ? 'Native' : cr.format === 'pop' ? 'Pop traffic' : 'Text'} · version {cr.version}{cr.approvedVersion && cr.approvedVersion !== cr.version ? ` (version ${cr.approvedVersion} serving)` : ''}</p>
                              </div>
                              <StatusBadge status={cr.status} />
                            </div>
                            <CreativePreview c={cr} />
                            {cr.rejectionReason && cr.status === 'rejected' && <p className="mt-2 text-sm text-danger">Not approved: {cr.rejectionReason}</p>}
                            <p className="mt-2 truncate text-xs text-muted">Goes to {cr.destinationUrl}</p>
                            {cr.status !== 'archived' && !['archived', 'completed'].includes(c.status) && (
                              <div className="mt-3 flex gap-2">
                                <Button size="sm" variant="secondary" onClick={() => setEditor({ creative: cr })}><Pencil className="size-3.5" /> Edit</Button>
                                <Button size="sm" variant="ghost" onClick={async () => { try { await post(`/orgs/${org.id}/creatives/${cr.id}/archive`); creatives.reload(); } catch (e) { setActionError(errorMessage(e)); } }}><Trash2 className="size-3.5" /> Archive</Button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </Async>
                  {editor && <CreativeEditor key={editor.creative?.id ?? 'new'} open onClose={() => setEditor(null)} orgId={org.id} campaignId={id} creative={editor.creative} pricingModel={res.data?.data.pricingModel} onSaved={() => { creatives.reload(); res.reload(); }} />}
                </Card>
              )}
              {tab === 'report' && <ReportExplorer orgId={org.id} audience="advertiser" currency={org.currency} filters={{ campaignId: id }} />}
              {tab === 'settings' && (editable ? (
                <>
                  {['active', 'scheduled', 'paused'].includes(c.status) && <Alert tone="warning" className="mb-4">Changing targeting on an approved campaign sends it back for review. The rate of an approved campaign cannot change; duplicate it instead.</Alert>}
                  <CampaignForm initial={c} lockedPricing={!['draft', 'rejected'].includes(c.status)} submitLabel="Save changes" onSubmit={async (p) => { const r = await patch<{ data: any }>(`/orgs/${org.id}/campaigns/${id}`, p); res.setData(r); setTab('overview'); }} />
                </>
              ) : <Card><EmptyState title={`A ${humanize(c.status).toLowerCase()} campaign cannot be edited`}>{c.status === 'pending_approval' ? 'Wait for the review to finish.' : 'Duplicate it to start a new campaign with the same settings.'}</EmptyState></Card>)}
              {tab === 'history' && (
                <Card>
                  <Async res={history}>
                    {({ data }) => (
                      <Table rows={data} rowKey={(r) => r.id} empty="No history yet." columns={[
                        { key: 'when', header: 'When', cell: (r) => <span title={formatDate(r.created_at, true)}>{timeAgo(r.created_at)}</span> },
                        { key: 'action', header: 'Action', cell: (r) => <Badge>{humanize(r.action)}</Badge> },
                        { key: 'who', header: 'By', cell: (r) => r.actor_name ?? 'System' },
                        { key: 'change', header: 'Change', cell: (r) => r.after?.status ? `${humanize(r.before?.status ?? '')} → ${humanize(r.after.status)}` : '' },
                        { key: 'reason', header: 'Reason', cell: (r) => r.reason ?? '' },
                      ]} />
                    )}
                  </Async>
                </Card>
              )}
            </div>
          </>
        );
      }}
    </Async>
  );
}

export default function Page() {
  return <Suspense><CampaignDetail /></Suspense>;
}
