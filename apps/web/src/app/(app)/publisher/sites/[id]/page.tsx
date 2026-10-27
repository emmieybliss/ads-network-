'use client';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { SITE_STATUS_LABELS, type SiteStatus } from '@blissnova/shared';
import { Alert, Async, Badge, Button, Card, CardHeader, DefinitionList, Field, Input, PageHeader, StatusBadge, Table, Tabs } from '@/components/ui';
import { AdsTxtPanel, PlacementsPanel, SubmitPanel, TagPanel, VerificationPanel, type SiteDetail } from '@/components/publisher/SitePanels';
import { ReportExplorer } from '@/components/ReportExplorer';
import { useApi } from '@/lib/hooks';
import { useOrg } from '@/lib/session';
import { errorMessage, patch } from '@/lib/api';
import { bpsToPercent, formatDate, humanize, timeAgo } from '@/lib/format';

const STEPS: Array<[string, SiteStatus[]]> = [
  ['Draft', ['draft']], ['Verify ownership', ['verification_pending']], ['Verified', ['verified']], ['Submitted', ['submitted']], ['Under review', ['under_review']], ['Approved', ['approved']],
];

function Stepper({ status }: { status: string }) {
  const idx = STEPS.findIndex(([, s]) => s.includes(status as SiteStatus));
  return (
    <ol className="flex flex-wrap gap-2 text-xs" aria-label="Site progress">
      {STEPS.map(([label], i) => (
        <li key={label} className={`rounded-full px-3 py-1 ${idx >= 0 && i < idx ? 'bg-success-soft text-success' : i === idx ? 'bg-primary text-primary-fg' : 'bg-surface-2 text-muted'}`} aria-current={i === idx ? 'step' : undefined}>{i + 1}. {label}</li>
      ))}
    </ol>
  );
}

function AllowedDomains({ orgId, site, onChange }: { orgId: string; site: SiteDetail; onChange: (s: SiteDetail) => void }) {
  const [value, setValue] = useState((site.allowedDomains ?? []).join(', '));
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await patch<{ data: SiteDetail }>(`/orgs/${orgId}/sites/${site.id}`, { allowedDomains: value.split(',').map((x: string) => x.trim()).filter(Boolean) });
      onChange(r.data);
      setMsg({ tone: 'success', text: 'Saved.' });
    } catch (err) {
      setMsg({ tone: 'danger', text: errorMessage(err) });
    }
  }
  return (
    <Card>
      <CardHeader title="Additional hostnames" description={site.verification.scope === 'zone' ? `Subdomains of ${site.domain} that may show ads, for example www.${site.domain}.` : `File and meta-tag proofs cover ${site.domain} only. To add subdomains, verify with a DNS TXT record or register them as separate sites.`} />
      <form onSubmit={save} className="flex flex-wrap items-end gap-3">
        <Field label="Hostnames" htmlFor="ad" className="min-w-[260px] flex-1"><Input id="ad" value={value} onChange={(e) => setValue(e.target.value)} placeholder={`www.${site.domain}`} /></Field>
        <Button type="submit" variant="secondary">Save</Button>
      </form>
      {msg && <Alert tone={msg.tone} className="mt-3">{msg.text}</Alert>}
    </Card>
  );
}

export default function SitePage() {
  const org = useOrg();
  const { id } = useParams<{ id: string }>();
  const res = useApi<{ data: SiteDetail }>(`/orgs/${org.id}/sites/${id}`);
  const [tab, setTab] = useState('setup');
  return (
    <Async res={res}>
      {({ data: s }) => {
        const set = (d: SiteDetail) => res.setData({ data: d });
        return (
          <>
            <PageHeader back={{ href: '/publisher/sites', label: 'Websites' }} title={<span className="flex flex-wrap items-center gap-2">{s.name} <StatusBadge status={s.status} label={SITE_STATUS_LABELS[s.status as SiteStatus]} />{s.verificationSimulated && <Badge tone="warning">Simulated verification</Badge>}</span>} description={s.domain} />
            <div className="mb-5"><Stepper status={s.status} /></div>
            {s.status === 'suspended' && <Alert tone="danger" title="Suspended" className="mb-4">{s.statusReason ?? 'Ads are not served on this site. Contact support for details.'}</Alert>}
            <Tabs active={tab} onChange={setTab} tabs={[{ id: 'setup', label: 'Setup' }, { id: 'placements', label: 'Placements' }, { id: 'tag', label: 'Ad tag' }, { id: 'report', label: 'Report' }, { id: 'details', label: 'Details' }]} />
            <div className="mt-5 space-y-5">
              {tab === 'setup' && (
                <>
                  <VerificationPanel orgId={org.id} site={s} onChange={set} />
                  <SubmitPanel key={s.status} orgId={org.id} site={s} onChange={set} />
                  {s.status === 'approved' && <Alert tone="success" title="Approved">This site can serve ads. Add placements and install the ad tag.</Alert>}
                  {s.verification.verified && <AllowedDomains orgId={org.id} site={s} onChange={set} />}
                </>
              )}
              {tab === 'placements' && <PlacementsPanel orgId={org.id} siteId={s.id} />}
              {tab === 'tag' && <TagPanel orgId={org.id} siteId={s.id} />}
              {tab === 'tag' && s.verification.verified && <AdsTxtPanel orgId={org.id} siteId={s.id} />}
              {tab === 'report' && <ReportExplorer orgId={org.id} audience="publisher" currency={org.currency} filters={{ siteId: s.id }} />}
              {tab === 'details' && (
                <>
                  <Card>
                    <CardHeader title="Site details" />
                    <DefinitionList items={[
                      ['Site key', <code key="k" className="text-xs">{s.siteKey}</code>], ['Category', humanize(s.category)], ['Language', s.language ?? '—'], ['Country', s.country ?? '—'],
                      ['Revenue share', `${bpsToPercent(s.effectiveRevenueShareBps)} to you`], ['Policies accepted', s.submission.policyAcceptedAt ? `Version ${s.submission.acceptedPolicyVersion} on ${formatDate(s.submission.policyAcceptedAt)}` : 'Not yet'],
                      ['Added', formatDate(s.createdAt)], ['Approved', s.approvedAt ? formatDate(s.approvedAt) : '—'],
                    ]} />
                  </Card>
                  <Card>
                    <CardHeader title="Review history" />
                    <Table rows={s.reviews} rowKey={(r) => r.at + r.action} empty="No review actions yet." columns={[
                      { key: 'a', header: 'When', cell: (r) => timeAgo(r.at) },
                      { key: 'b', header: 'Action', cell: (r) => humanize(r.action) },
                      { key: 'c', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
                      { key: 'd', header: 'Reason', cell: (r) => r.reason ?? '' },
                    ]} />
                  </Card>
                </>
              )}
            </div>
          </>
        );
      }}
    </Async>
  );
}
