'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Input, PageHeader, Select } from '@/components/ui';
import { CATEGORIES } from '@/components/publisher/SitePanels';
import { errorMessage, post } from '@/lib/api';
import { useOrg } from '@/lib/session';
import { humanize } from '@/lib/format';

export default function NewSite() {
  const org = useOrg();
  const router = useRouter();
  const [f, setF] = useState({ name: '', domain: '', category: 'general' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ data: { id: string } }>(`/orgs/${org.id}/sites`, f);
      router.push(`/publisher/sites/${r.data.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader title="Add a website" description="The site starts as a draft. Next you verify that you control its domain." back={{ href: '/publisher/sites', label: 'Websites' }} />
      <Card className="max-w-xl">
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Website name" htmlFor="sn" required><Input id="sn" required maxLength={160} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Domain" htmlFor="sd" required hint="The hostname only, for example example.com or blog.example.com. No https:// or paths."><Input id="sd" required value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} placeholder="example.com" /></Field>
          <Field label="Category" htmlFor="sc"><Select id="sc" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select></Field>
          <Button type="submit" loading={busy}>Create and continue</Button>
        </form>
      </Card>
    </>
  );
}
