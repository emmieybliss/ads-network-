'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ADMIN_CAMPAIGN_TRANSITIONS } from '@blissnova/shared';
import { Alert, Async, Badge, Card, CardHeader, DefinitionList, Field, Input, PageHeader, StatusBadge } from '@/components/ui';
import { NotesPanel, ReasonAction, SimpleTable } from '@/components/admin/kit';
import { CreativePreview } from '@/components/advertiser/CreativeEditor';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { patch } from '@/lib/api';
import { formatDate, formatMicros, formatNumber, formatPercent, humanize, microsToInput, timeAgo } from '@/lib/format';

export default function AdminCampaign() {
  const { id } = useParams<{ id: string }>();
  const { canAdmin } = useSession();
  const res = useApi<{ data: any }>(`/admin/campaigns/${id}`);
  const [limits, setLimits] = useState<{ lifetimeBudget: string; dailyBudget: string; priorityBoost: string } | null>(null);
  return (
    <Async res={res}>
      {({ data: c }) => {
        const money = (v: string | null) => formatMicros(v, c.currency);
        const can = (a: string) => ADMIN_CAMPAIGN_TRANSITIONS[a]?.includes(c.status);
        const review = canAdmin('admin:campaigns:review');
        const override = canAdmin('admin:campaigns:override');
        const l = limits ?? { lifetimeBudget: microsToInput(c.lifetimeBudgetMicros), dailyBudget: microsToInput(c.dailyBudgetMicros), priorityBoost: String(c.adminPriorityBoost ?? 0) };
        return (
          <>
            <PageHeader back={{ href: '/admin/campaigns', label: 'Campaigns' }} title={<span className="flex items-center gap-2">{c.name} <StatusBadge status={c.status} /></span>}
              description={<Link className="text-primary hover:underline" href={`/admin/orgs/${c.org.id}`}>{c.org.name}</Link>}
              actions={
                <div className="flex flex-wrap gap-2">
                  {review && can('approve') && <ReasonAction label="Approve" title="Approve campaign" path={`/admin/campaigns/${id}/approve`} variant="primary" requireReason={false} onDone={res.reload} description="Every creative must already be approved. The campaign starts at its scheduled time." />}
                  {review && can('reject') && <ReasonAction label="Reject" title="Reject campaign" path={`/admin/campaigns/${id}/reject`} danger onDone={res.reload} />}
                  {override && can('pause') && <ReasonAction label="Pause" title="Pause campaign" path={`/admin/campaigns/${id}/pause`} onDone={res.reload} />}
                  {override && can('resume') && <ReasonAction label="Resume" title="Resume campaign" path={`/admin/campaigns/${id}/resume`} onDone={res.reload} />}
                  {override && can('suspend') && <ReasonAction label="Suspend" title="Suspend campaign" path={`/admin/campaigns/${id}/suspend`} variant="danger" danger onDone={res.reload} />}
                  {override && can('terminate') && <ReasonAction label="Terminate" title="Terminate campaign" path={`/admin/campaigns/${id}/terminate`} variant="danger" danger onDone={res.reload} description="Ends the campaign permanently and releases unspent reserve to the advertiser." />}
                </div>
              } />
            {c.statusReason && <Alert tone="warning" className="mb-4">{c.statusReason}</Alert>}
            <div className="grid gap-5 lg:grid-cols-2">
              <Card>
                <CardHeader title="Settings" />
                <DefinitionList items={[
                  ['Pricing', `${c.pricingModel.toUpperCase()} ${money(c.rateMicros)}`], ['Lifetime budget', money(c.lifetimeBudgetMicros)], ['Daily budget', c.dailyBudgetMicros ? money(c.dailyBudgetMicros) : 'None'],
                  ['Spent', money(c.spentMicros)], ['Reserved', money(c.reservedMicros)], ['Schedule', `${formatDate(c.startAt, true)} – ${c.endAt ? formatDate(c.endAt, true) : 'open'}`],
                  ['Pacing / priority', `${humanize(c.pacing)} / ${c.priority}${c.adminPriorityBoost ? ` (boost ${c.adminPriorityBoost})` : ''}`],
                  ['Countries', c.targeting?.countries?.join(', ') || 'All'], ['Devices', c.targeting?.devices?.join(', ') || 'All'], ['Categories', c.targeting?.siteCategories?.join(', ') || 'All'],
                  ['Frequency caps', c.caps.length ? c.caps.map((x: any) => `${x.maxImpressions}/${x.scope}/${Math.round(x.windowSeconds / 3600)}h`).join(', ') : 'None'],
                ]} />
              </Card>
              {override && (
                <Card>
                  <CardHeader title="Admin limits" description="Override budgets or priority. Requires a reason and password confirmation." />
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Lifetime budget" htmlFor="alb"><Input id="alb" value={l.lifetimeBudget} onChange={(e) => setLimits({ ...l, lifetimeBudget: e.target.value })} /></Field>
                    <Field label="Daily budget" htmlFor="adb"><Input id="adb" value={l.dailyBudget} onChange={(e) => setLimits({ ...l, dailyBudget: e.target.value })} /></Field>
                    <Field label="Priority boost (-5 to 5)" htmlFor="apb"><Input id="apb" type="number" min={-5} max={5} value={l.priorityBoost} onChange={(e) => setLimits({ ...l, priorityBoost: e.target.value })} /></Field>
                  </div>
                  <div className="mt-3"><ReasonAction label="Apply limits" title="Apply admin limits" path="" onDone={() => { setLimits(null); res.reload(); }} run={(reason) => patch(`/admin/campaigns/${id}/limits`, { lifetimeBudget: l.lifetimeBudget, dailyBudget: l.dailyBudget || null, priorityBoost: Number(l.priorityBoost), reason })} /></div>
                </Card>
              )}
              <Card className="lg:col-span-2">
                <CardHeader title="Creatives" />
                <div className="grid gap-4 md:grid-cols-3">
                  {c.creatives.map((cr: any) => (
                    <div key={cr.id} className="rounded-xl border border-border p-3">
                      <div className="mb-2 flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{cr.name}</span><StatusBadge status={cr.status} /></div>
                      <CreativePreview c={cr} />
                      <p className="mt-2 truncate text-xs text-muted">{cr.destinationUrl}</p>
                    </div>
                  ))}
                </div>
                {c.creatives.some((cr: any) => cr.status === 'pending_review') && <p className="mt-3 text-sm"><Link className="text-primary hover:underline" href="/admin/creatives">Review pending creatives</Link></p>}
              </Card>
              <Card>
                <CardHeader title="Delivery by site (30 days)" />
                <SimpleTable rows={c.last30DaysBySite.rows} rowKey={(r: any) => r.key} empty="No delivery." columns={[
                  { key: 's', header: 'Site', cell: (r: any) => r.label }, { key: 'v', header: 'Valid impr.', align: 'right', cell: (r: any) => formatNumber(r.validImpressions) },
                  { key: 'i', header: 'Invalid', align: 'right', cell: (r: any) => formatNumber(r.invalidImpressions) }, { key: 'c', header: 'CTR', align: 'right', cell: (r: any) => formatPercent(r.ctr) },
                ]} />
              </Card>
              <Card>
                <CardHeader title="History" />
                <SimpleTable rows={c.history} rowKey={(r: any) => r.created_at + r.action} columns={[
                  { key: 'w', header: 'When', cell: (r: any) => timeAgo(r.created_at) }, { key: 'a', header: 'Action', cell: (r: any) => <Badge>{humanize(r.action)}</Badge> }, { key: 'b', header: 'By', cell: (r: any) => r.actor ?? 'System' }, { key: 'r', header: 'Reason', cell: (r: any) => r.reason ?? '' },
                ]} />
              </Card>
              <NotesPanel subjectType="campaign" subjectId={c.id} />
            </div>
          </>
        );
      }}
    </Async>
  );
}
