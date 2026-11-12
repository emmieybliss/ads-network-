'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Async, Badge, Button, Card, CardHeader, Field, Modal, PageHeader, Stat, StatusBadge, Table, Textarea } from '@/components/ui';
import { TrendChart } from '@/components/charts';
import { QUALITY_LABELS, QUALITY_TONES, reasonLabel } from '@/lib/ivt';
import { useApi, useConfig } from '@/lib/hooks';
import { useOrg } from '@/lib/session';
import { errorMessage, post } from '@/lib/api';
import { formatDate, formatMicros, formatNumber, formatPercent, humanize } from '@/lib/format';

const QUALITY_HELP: Record<string, string> = {
  healthy: 'Your traffic looks like real people. Keep it that way.',
  watch: 'More of your traffic than usual is being filtered. Check where your visitors come from.',
  review: 'A lot of your traffic is being filtered. Our team is reviewing it; earnings from invalid traffic will be removed.',
  low_volume: 'Not enough traffic in this period to judge.',
};

function TrafficQuality({ orgId }: { orgId: string }) {
  const res = useApi<{ data: any }>(`/orgs/${orgId}/traffic-quality?days=30`);
  return (
    <Async res={res}>{({ data }) => (
      <div className="space-y-5">
        <Card>
          <CardHeader title="Your traffic quality" description="Last 30 days. Invalid traffic is never paid; this is how much of yours was filtered, and why." actions={<Badge tone={QUALITY_TONES[data.status]}>{QUALITY_LABELS[data.status]}</Badge>} />
          <p className="mb-4 text-sm text-fg-2">{QUALITY_HELP[data.status]}</p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Invalid traffic rate" value={data.ivtRate == null ? '—' : formatPercent(data.ivtRate, 1)} hint={data.previousRate == null ? undefined : `${formatPercent(data.previousRate, 1)} the 30 days before`} definition={`Impressions filtered as invalid, out of all impressions. We review accounts at ${data.reviewAtPercent}% or more.`} />
            <Stat label="Impressions filtered" value={formatNumber(data.invalidImpressions)} hint={`of ${formatNumber(data.rendered)}`} />
            <Stat label="Invalid clicks" value={data.invalidClickRate == null ? '—' : formatPercent(data.invalidClickRate, 1)} hint={`${formatNumber(data.invalidClicks)} ${data.invalidClicks === 1 ? 'click' : 'clicks'}`} />
            <Stat label="Earnings removed" value={formatMicros(data.clawbacks.reduce((a: bigint, c: any) => a + BigInt(c.publisher_micros), 0n).toString())} hint="for invalid traffic found later" />
          </div>
          {data.daily.length > 1 && <div className="mt-5"><TrendChart height={200} data={data.daily.map((d: any) => ({ label: d.day, rate: d.rendered ? Number(((d.invalid / d.rendered) * 100).toFixed(1)) : 0 }))} series={[{ key: 'rate', label: 'Invalid %', color: 'var(--chart-4)', format: (v) => `${v}%` }]} /></div>}
        </Card>
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Why traffic was filtered" />
            <Table rows={data.reasons} rowKey={(r: any) => r.reason + r.type} empty="Nothing was filtered." columns={[
              { key: 'r', header: 'Reason', cell: (r: any) => reasonLabel(r.reason) },
              { key: 't', header: 'Event', cell: (r: any) => humanize(r.type === 'render' ? 'impression' : r.type) },
              { key: 'n', header: 'Count', align: 'right', cell: (r: any) => formatNumber(r.events) },
            ]} />
          </Card>
          <Card>
            <CardHeader title="Earnings removed" description="When invalid traffic is found after it was counted, its earnings are removed while they are still on hold." />
            <Table rows={data.clawbacks} rowKey={(r: any) => r.id} empty="Nothing has been removed." columns={[
              { key: 'd', header: 'Date', cell: (r: any) => formatDate(r.created_at) },
              { key: 'b', header: 'By', cell: (r: any) => (r.automatic ? 'Automatic check' : 'Review team') },
              { key: 'e', header: 'Events', align: 'right', cell: (r: any) => formatNumber(r.excluded_events) },
              { key: 'm', header: 'Amount', align: 'right', cell: (r: any) => formatMicros(r.publisher_micros) },
            ]} />
          </Card>
        </div>
      </div>
    )}</Async>
  );
}

export default function Policy() {
  const org = useOrg();
  const cfg = useConfig().data?.data;
  const cases = useApi<{ data: any[] }>(`/orgs/${org.id}/fraud-cases`);
  const [appeal, setAppeal] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Policy & traffic quality" description="How we keep the network trustworthy, and any cases that involve your account." />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Policies" />
          <ul className="space-y-2 text-sm">
            <li><Link className="text-primary hover:underline" href="/policies/publishers">Publisher policies</Link></li>
            <li><Link className="text-primary hover:underline" href="/publisher-requirements">Publisher requirements</Link></li>
            <li><Link className="text-primary hover:underline" href="/policies/creatives">Creative rules</Link></li>
            <li><Link className="text-primary hover:underline" href="/report-abuse">Report abuse</Link></li>
          </ul>
        </Card>
        <Card>
          <CardHeader title="Never allowed" />
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg-2">
            <li>Clicking your own ads or asking others to click</li>
            <li>Bought, incentivized or automated traffic, including traffic from cloud servers, VPN farms and scripted browsers</li>
            <li>Placing ads where they can be mistaken for content or navigation</li>
            {cfg?.eligibility.prohibitedContent.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </Card>
      </div>
      <div className="mt-5"><TrafficQuality orgId={org.id} /></div>
      <Card className="mt-5">
        <CardHeader title="Traffic quality cases" description="If invalid traffic is confirmed, related earnings are reversed. You can appeal a confirmed case once." />
        {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
        <Async res={cases}>
          {({ data }) => <Table rows={data} rowKey={(r) => r.id} empty="No cases. Keep it that way by following the policies above." columns={[
            { key: 't', header: 'Case', cell: (r) => r.title },
            { key: 'sv', header: 'Severity', cell: (r) => <Badge tone={r.severity === 'high' || r.severity === 'critical' ? 'danger' : 'warning'}>{humanize(r.severity)}</Badge> },
            { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            { key: 'o', header: 'Outcome', cell: (r) => <span className="text-sm">{r.outcome ?? (['open', 'investigating'].includes(r.status) ? 'Under review' : '')}{r.source === 'auto' && <span className="ml-1 text-xs text-muted">(automatic)</span>}</span> },
            { key: 'd', header: 'Opened', cell: (r) => formatDate(r.created_at) },
            { key: 'a', header: '', cell: (r) => r.status === 'confirmed' && !r.appeal_text ? <Button size="sm" variant="secondary" onClick={() => setAppeal({ id: r.id, text: '' })}>Appeal</Button> : r.appeal_text ? <span className="text-xs text-muted">Appealed</span> : null },
          ]} />}
        </Async>
      </Card>
      <Modal open={!!appeal} onClose={() => setAppeal(null)} title="Appeal this decision" footer={<Button onClick={async () => { try { await post(`/orgs/${org.id}/fraud-cases/${appeal!.id}/appeal`, { text: appeal!.text }); setAppeal(null); cases.reload(); } catch (e) { setError(errorMessage(e)); setAppeal(null); } }}>Send appeal</Button>}>
        {appeal && <Field label="Why should this be reconsidered?" htmlFor="ap" hint="At least 20 characters. Include any evidence about your traffic sources."><Textarea id="ap" rows={6} value={appeal.text} onChange={(e) => setAppeal({ ...appeal, text: e.target.value })} /></Field>}
      </Modal>
    </>
  );
}
