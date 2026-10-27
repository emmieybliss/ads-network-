'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Async, Badge, Button, Card, CardHeader, DefinitionList, Field, Input, PageHeader, ReasonDialog, StatusBadge } from '@/components/ui';
import { NotesPanel, ReasonAction, SimpleTable } from '@/components/admin/kit';
import { PremiumCard } from '@/components/admin/PremiumCard';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { patch } from '@/lib/api';
import { bpsToPercent, formatDate, formatMicros, humanize, timeAgo } from '@/lib/format';

export default function OrgDetail() {
  const { id } = useParams<{ id: string }>();
  const { canAdmin } = useSession();
  const res = useApi<{ data: any }>(`/admin/orgs/${id}`);
  const [share, setShare] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  return (
    <Async res={res}>
      {({ data: o }) => {
        const money = (v: string) => formatMicros(v, o.currency);
        const review = canAdmin('admin:orgs:review');
        const suspend = canAdmin('admin:orgs:suspend');
        return (
          <>
            <PageHeader back={{ href: '/admin/orgs', label: 'Organizations' }} title={<span className="flex items-center gap-2">{o.name} <StatusBadge status={o.status} />{o.tier === 'premium' && <Badge tone="info">Premium</Badge>}</span>} description={`${humanize(o.type)} · ${o.currency}${o.country ? ` · ${o.country}` : ''}`}
              actions={
                <div className="flex flex-wrap gap-2">
                  {review && ['pending', 'rejected'].includes(o.status) && <ReasonAction label="Approve" title={`Approve ${o.name}`} path={`/admin/orgs/${id}/approve`} variant="primary" requireReason={false} onDone={res.reload} />}
                  {review && o.status === 'pending' && <ReasonAction label="Reject" title={`Reject ${o.name}`} path={`/admin/orgs/${id}/reject`} danger onDone={res.reload} />}
                  {suspend && ['approved', 'pending'].includes(o.status) && <ReasonAction label="Suspend" title={`Suspend ${o.name}`} path={`/admin/orgs/${id}/suspend`} variant="danger" danger onDone={res.reload} description="Stops serving for all campaigns or sites of this organization." />}
                  {suspend && o.status === 'suspended' && <ReasonAction label="Reinstate" title={`Reinstate ${o.name}`} path={`/admin/orgs/${id}/reinstate`} onDone={res.reload} />}
                </div>
              } />
            {o.status_reason && <Alert tone="warning" className="mb-4">{o.status_reason}</Alert>}
            <div className="grid gap-5 lg:grid-cols-2">
              <Card>
                <CardHeader title="Details" />
                <DefinitionList items={[
                  ['Website', o.website ?? '—'], ['Billing email', o.billing_email ?? '—'], ['Created', formatDate(o.created_at)],
                  ...Object.entries(o.balances as Record<string, string>).map(([k, v]) => [humanize(k), money(v)] as [string, string]),
                  ...(o.type === 'publisher' ? [['Revenue share', o.revenue_share_bps != null ? bpsToPercent(o.revenue_share_bps) : 'Platform default'] as [string, string]] : []),
                ]} />
                {o.type === 'publisher' && canAdmin('admin:pricing:manage') && (
                  <div className="mt-4 flex items-end gap-2">
                    <Field label="Revenue share to publisher (%)" htmlFor="rs" hint="Empty for the platform default."><Input id="rs" type="number" min={0} max={100} step="0.01" value={share} onChange={(e) => setShare(e.target.value)} /></Field>
                    <Button size="sm" variant="secondary" onClick={() => setShareOpen(true)}>Update</Button>
                  </div>
                )}
              </Card>
              <PremiumCard key={`${o.tier}-${o.earnings_mode}-${o.min_cpm_micros}-${o.min_cpc_micros}`} org={o} canEdit={canAdmin('admin:pricing:manage')} onSaved={res.reload} />
              <Card>
                <CardHeader title="Members" />
                <SimpleTable rows={o.members} rowKey={(r: any) => r.id} columns={[
                  { key: 'n', header: 'Name', cell: (r: any) => <Link className="text-primary hover:underline" href={`/admin/users/${r.id}`}>{r.name}</Link> },
                  { key: 'e', header: 'Email', cell: (r: any) => r.email }, { key: 'r', header: 'Role', cell: (r: any) => humanize(r.role) },
                ]} />
              </Card>
              {o.type === 'advertiser' ? (
                <Card>
                  <CardHeader title="Campaigns" />
                  <SimpleTable rows={o.campaigns} rowKey={(r: any) => r.id} columns={[
                    { key: 'n', header: 'Name', cell: (r: any) => <Link className="text-primary hover:underline" href={`/admin/campaigns/${r.id}`}>{r.name}</Link> },
                    { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> },
                    { key: 'b', header: 'Spent / budget', align: 'right', cell: (r: any) => `${money(r.spent_micros)} / ${money(r.lifetime_budget_micros)}` },
                  ]} />
                </Card>
              ) : (
                <Card>
                  <CardHeader title="Sites" />
                  <SimpleTable rows={o.sites} rowKey={(r: any) => r.id} columns={[
                    { key: 'n', header: 'Domain', cell: (r: any) => <Link className="text-primary hover:underline" href={`/admin/sites/${r.id}`}>{r.domain}</Link> },
                    { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> },
                    { key: 'v', header: 'Verified', cell: (r: any) => (r.verified_at ? formatDate(r.verified_at) : 'No') },
                  ]} />
                </Card>
              )}
              <Card>
                <CardHeader title={o.type === 'advertiser' ? 'Payments' : 'Payouts'} />
                <SimpleTable rows={o.type === 'advertiser' ? o.payments : o.payouts} rowKey={(r: any) => r.id} columns={[
                  { key: 'd', header: 'Date', cell: (r: any) => formatDate(r.created_at) }, { key: 'a', header: 'Amount', align: 'right', cell: (r: any) => money(r.amount_micros) }, { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> },
                ]} />
              </Card>
              <Card>
                <CardHeader title="Recent audit events" />
                <SimpleTable rows={o.audit.slice(0, 20)} rowKey={(r: any) => r.created_at + r.action} columns={[{ key: 'a', header: 'Action', cell: (r: any) => r.action }, { key: 'b', header: 'By', cell: (r: any) => r.actor ?? 'System' }, { key: 'w', header: 'When', cell: (r: any) => timeAgo(r.created_at) }]} />
              </Card>
              <NotesPanel subjectType="organization" subjectId={o.id} />
            </div>
            <ReasonDialog open={shareOpen} onClose={() => setShareOpen(false)} title="Change revenue share" confirmLabel="Update"
              onConfirm={async (reason) => { await patch(`/admin/orgs/${id}/revenue-share`, { revenueShareBps: share === '' ? null : Math.round(Number(share) * 100), reason }); setShareOpen(false); res.reload(); }} />
          </>
        );
      }}
    </Async>
  );
}
