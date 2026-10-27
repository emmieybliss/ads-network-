'use client';
import { useState } from 'react';
import { Alert, Button, ErrorNotice, Field, Input, Select, Textarea } from '@/components/ui';
import { post } from '@/lib/api';

export function ReportForm() {
  const [f, setF] = useState({ reporterEmail: '', subjectType: 'creative', subjectRef: '', body: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (done) return <Alert tone="success" title="Thank you" className="mt-8">Your report was received.</Alert>;
  return (
    <form
      className="mt-8 space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          await post('/public/abuse-reports', { ...f, reporterEmail: f.reporterEmail || undefined, subjectRef: f.subjectRef || undefined });
          setDone(true);
        } catch (x) {
          setErr(x);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="What are you reporting?" required>
        <Select value={f.subjectType} onChange={(e) => setF({ ...f, subjectType: e.target.value })}>
          <option value="creative">An advertisement</option><option value="site">A publisher website</option><option value="campaign">A campaign</option><option value="other">Something else</option>
        </Select>
      </Field>
      <Field label="Where did you see it?" hint="A page address, or the ad's destination address.">
        <Input value={f.subjectRef} onChange={(e) => setF({ ...f, subjectRef: e.target.value })} maxLength={500} />
      </Field>
      <Field label="What is wrong?" required>
        <Textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} minLength={10} maxLength={5000} required />
      </Field>
      <Field label="Your email (optional)" hint="Only if you would like a reply.">
        <Input type="email" value={f.reporterEmail} onChange={(e) => setF({ ...f, reporterEmail: e.target.value })} />
      </Field>
      <ErrorNotice error={err} />
      <Button type="submit" loading={busy} disabled={f.body.trim().length < 10}>Send report</Button>
    </form>
  );
}
