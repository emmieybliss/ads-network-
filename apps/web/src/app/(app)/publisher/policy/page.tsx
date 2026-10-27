'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Async, Badge, Button, Card, CardHeader, Field, Modal, PageHeader, StatusBadge, Table, Textarea } from '@/components/ui';
import { useApi, useConfig } from '@/lib/hooks';
import { useOrg } from '@/lib/session';
import { errorMessage, post } from '@/lib/api';
import { formatDate, humanize } from '@/lib/format';

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
            <li>Bought, incentivized or automated traffic</li>
            <li>Placing ads where they can be mistaken for content or navigation</li>
            {cfg?.eligibility.prohibitedContent.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </Card>
      </div>
      <Card className="mt-5">
        <CardHeader title="Traffic quality cases" description="If invalid traffic is confirmed, related earnings are reversed. You can appeal a confirmed case once." />
        {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
        <Async res={cases}>
          {({ data }) => <Table rows={data} rowKey={(r) => r.id} empty="No cases. Keep it that way by following the policies above." columns={[
            { key: 't', header: 'Case', cell: (r) => r.title },
            { key: 'sv', header: 'Severity', cell: (r) => <Badge tone={r.severity === 'high' || r.severity === 'critical' ? 'danger' : 'warning'}>{humanize(r.severity)}</Badge> },
            { key: 's', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            { key: 'o', header: 'Outcome', cell: (r) => r.outcome ?? '' },
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
