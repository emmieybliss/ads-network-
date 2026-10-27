'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ADMIN_SITE_TRANSITIONS, SITE_STATUS_LABELS, type SiteStatus } from '@blissnova/shared';
import { Alert, Async, Badge, Button, Card, CardHeader, Checkbox, DefinitionList, Field, PageHeader, StatusBadge, Textarea } from '@/components/ui';
import { NotesPanel, ReasonAction, SimpleTable } from '@/components/admin/kit';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { errorMessage, patch, post } from '@/lib/api';
import { formatDate, formatMicros, formatNumber, humanize, timeAgo } from '@/lib/format';

function ReviewForm({ site, onDone }: { site: any; onDone: () => void }) {
  const e = site.eligibility;
  const items: Array<[string, string]> = [
    ['ownership_verified', 'Domain control verified'],
    ...(e.requireOriginalContent ? [['original_content', 'Original content the publisher has rights to'] as [string, string]] : []),
    ...(e.requirePrivacyPolicy ? [['privacy_policy', 'Privacy policy present and discloses advertising'] as [string, string]] : []),
    ...(e.requireContactInformation ? [['contact_information', 'Contact information present'] as [string, string]] : []),
    ...(e.requireTrafficIntegrity ? [['traffic_integrity', 'No signs of bought, incentivized or automated traffic'] as [string, string]] : []),
    ['no_prohibited_content', 'No prohibited content'],
    ['policies_accepted', 'Publisher policies accepted'],
  ];
  const [checks, setChecks] = useState<Record<string, boolean>>({ ownership_verified: !!site.verifiedAt, policies_accepted: !!site.policyAcceptedAt });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const can = (a: string) => ADMIN_SITE_TRANSITIONS[a]?.includes(site.status);
  const all = items.every(([k]) => checks[k]);

  async function act(action: string) {
    setBusy(action);
    setError(null);
    try {
      await post(`/admin/sites/${site.id}/${action}`, { reason: reason || undefined, checklist: checks });
      setReason('');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader title="Review" description="Approval is a human decision. Verification alone never approves a site." />
      {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
      <div className="space-y-2">{items.map(([k, l]) => <Checkbox key={k} label={l} checked={!!checks[k]} onChange={(v) => setChecks({ ...checks, [k]: v })} />)}</div>
      {e.minMonthlyPageviews != null && <p className="mt-3 text-sm text-muted">Configured traffic threshold: {formatNumber(e.minMonthlyPageviews)} monthly page views. Reported: {site.reportedMonthlyPageviews != null ? formatNumber(site.reportedMonthlyPageviews) : 'not provided'}.</p>}
      <Field label="Reason or note to the publisher" htmlFor="rr" className="mt-4" hint="Required to reject or suspend. Sent to the publisher."><Textarea id="rr" rows={3} value={reason} onChange={(ev) => setReason(ev.target.value)} /></Field>
      <div className="mt-4 flex flex-wrap gap-2">
        {can('start-review') && <Button variant="secondary" onClick={() => act('start-review')} loading={busy === 'start-review'}>Start review</Button>}
        {can('approve') && <Button onClick={() => act('approve')} loading={busy === 'approve'} disabled={!all}>Approve</Button>}
        {can('reject') && <Button variant="danger" onClick={() => act('reject')} loading={busy === 'reject'} disabled={reason.trim().length < 3}>Reject</Button>}
        {can('suspend') && <Button variant="danger" onClick={() => act('suspend')} loading={busy === 'suspend'} disabled={reason.trim().length < 3}>Suspend</Button>}
        {can('reinstate') && <Button onClick={() => act('reinstate')} loading={busy === 'reinstate'} disabled={reason.trim().length < 3}>Reinstate</Button>}
      </div>
      {can('approve') && !all && <p className="mt-2 text-xs text-muted">Tick every check to approve.</p>}
    </Card>
  );
}

export default function AdminSite() {
  const { id } = useParams<{ id: string }>();
  const { canAdmin } = useSession();
  const res = useApi<{ data: any }>(`/admin/sites/${id}`);
  return (
    <Async res={res}>
      {({ data: s }) => (
        <>
          <PageHeader back={{ href: '/admin/sites', label: 'Publisher sites' }} title={<span className="flex flex-wrap items-center gap-2">{s.domain} <StatusBadge status={s.status} label={SITE_STATUS_LABELS[s.status as SiteStatus]} />{s.verificationSimulated && <Badge tone="warning">Simulated verification</Badge>}</span>}
            description={<>{s.name} · <Link className="text-primary hover:underline" href={`/admin/orgs/${s.orgId}`}>{s.orgName}</Link></>}
            actions={canAdmin('admin:sites:review') && (
              <div className="flex flex-wrap gap-2">
                {!s.verifiedAt && <ReasonAction label="Mark verified manually" title="Record manual verification" path={`/admin/sites/${id}/mark-verified`} onDone={res.reload} description="Use only after you have confirmed domain control another way. The evidence is your reason, which is audited." />}
                {s.verifiedAt && <ReasonAction label="Revoke verification" title="Revoke domain verification" path={`/admin/sites/${id}/revoke-verification`} variant="danger" danger onDone={res.reload} description="The site stops serving until ownership is verified again." />}
              </div>
            )} />
          {s.statusReason && <Alert tone="warning" className="mb-4">{s.statusReason}</Alert>}
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-5">
              {canAdmin('admin:sites:review') && <ReviewForm key={s.status} site={s} onDone={res.reload} />}
              <Card>
                <CardHeader title="Submission" />
                <DefinitionList items={[
                  ['Description', s.description ?? '—'], ['Category', humanize(s.category)], ['Language / country', `${s.language ?? '—'} / ${s.country ?? '—'}`],
                  ['Reported monthly page views', s.reportedMonthlyPageviews != null ? formatNumber(s.reportedMonthlyPageviews) : '—'], ['Traffic sources', s.trafficSources ?? '—'],
                  ['Policies accepted', s.policyAcceptedAt ? `Version ${s.policyVersion} on ${formatDate(s.policyAcceptedAt, true)}` : 'No'], ['Submitted', s.submittedAt ? formatDate(s.submittedAt, true) : '—'],
                  ['Extra hostnames', s.allowedDomains?.length ? s.allowedDomains.join(', ') : 'None'],
                ]} />
              </Card>
              <Card>
                <CardHeader title="Last 30 days" />
                <DefinitionList items={[['Valid impressions', formatNumber(s.last30Days.valid)], ['Invalid impressions', formatNumber(s.last30Days.invalid)], ['Valid clicks', formatNumber(s.last30Days.clicks)], ['Publisher earnings', formatMicros(s.last30Days.earnings)]]} />
              </Card>
            </div>
            <div className="space-y-5">
              <Card>
                <CardHeader title="Verification evidence" description={s.verifiedAt ? `Verified ${formatDate(s.verifiedAt, true)} by ${humanize(s.verificationMethod)}, scope ${s.verificationScope}.` : 'Not verified.'} />
                <SimpleTable rows={s.attempts} rowKey={(r: any) => r.created_at + r.method} empty="No checks yet." columns={[
                  { key: 'w', header: 'When', cell: (r: any) => timeAgo(r.created_at) },
                  { key: 'm', header: 'Method', cell: (r: any) => humanize(r.method) },
                  { key: 'o', header: 'Outcome', cell: (r: any) => <span className="flex gap-1"><StatusBadge status={r.outcome} />{r.simulated && <Badge tone="warning">Simulated</Badge>}</span> },
                  { key: 'd', header: 'Detail', cell: (r: any) => <span className="text-xs">{r.detail ?? ''}{r.actor_email ? ` (${r.actor_email})` : ''}</span> },
                ]} />
              </Card>
              <Card>
                <CardHeader title="Review history" />
                <SimpleTable rows={s.reviews} rowKey={(r: any) => r.created_at + r.action} empty="No review actions yet." columns={[
                  { key: 'w', header: 'When', cell: (r: any) => timeAgo(r.created_at) }, { key: 'a', header: 'Action', cell: (r: any) => humanize(r.action) },
                  { key: 's', header: 'Status', cell: (r: any) => `${humanize(r.from_status)} → ${humanize(r.to_status)}` }, { key: 'b', header: 'By', cell: (r: any) => r.reviewer_email ?? '' }, { key: 'r', header: 'Reason', cell: (r: any) => r.reason ?? '' },
                ]} />
              </Card>
              <Card>
                <CardHeader title="Placements" />
                <SimpleTable rows={s.units} rowKey={(r: any) => r.id} columns={[
                  { key: 'n', header: 'Name', cell: (r: any) => `${r.name} (${r.key})` }, { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status} /> },
                  { key: 'b', header: '', cell: (r: any) => canAdmin('admin:inventory:manage') && <ReasonAction label={r.adminBlocked ? 'Unblock' : 'Block'} title={`${r.adminBlocked ? 'Unblock' : 'Block'} placement ${r.key}`} path="" onDone={res.reload} run={(reason) => patch(`/admin/units/${r.id}`, { adminBlocked: !r.adminBlocked, reason })} /> },
                ]} />
              </Card>
              <NotesPanel subjectType="site" subjectId={s.id} />
            </div>
          </div>
        </>
      )}
    </Async>
  );
}
