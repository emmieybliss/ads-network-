'use client';
import { useState } from 'react';
import { Mail } from 'lucide-react';
import { Button, Select } from '../ui';
import { useApi } from '@/lib/hooks';
import { errorMessage, post, put } from '@/lib/api';

interface ReportEmailState { frequency: 'off' | 'daily' | 'weekly' | 'monthly'; lastPeriodEnd: string | null; nextSendAt: string | null }

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';

/** The signed-in user's scheduled report email for this organization, and a "send one now" button. */
export function ReportEmailControl({ path }: { path: string }) {
  const res = useApi<{ data: ReportEmailState }>(path);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const s = res.data?.data;

  const change = async (frequency: string) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await put<{ data: ReportEmailState }>(path, { frequency });
      res.setData(r);
    } catch (e) {
      setNote(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await post<{ data: { sentTo: string } }>(`${path}/test`);
      setNote(`Sent the last 7 days to ${r.data.sentTo}.`);
    } catch (e) {
      setNote(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Mail className="size-4 text-muted" aria-hidden />
      <div className="w-[230px]"><Select aria-label="Email reports" value={s?.frequency ?? 'off'} disabled={!s || busy} onChange={(e) => void change(e.target.value)}>
        <option value="off">Email reports: off</option>
        <option value="daily">Email reports: daily</option>
        <option value="weekly">Email reports: weekly</option>
        <option value="monthly">Email reports: monthly</option>
      </Select></div>
      <Button variant="ghost" size="sm" onClick={() => void test()} disabled={!s || busy}>Send me one now</Button>
      <span className="text-xs text-muted" aria-live="polite">{note ?? (s?.nextSendAt ? `Next: ${when(s.nextSendAt)}` : '')}</span>
    </div>
  );
}
