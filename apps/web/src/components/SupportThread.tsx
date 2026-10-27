'use client';
import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Checkbox, Textarea, cn } from './ui';
import { errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';

export interface SupportMessage { id: string; body: string; fromStaff: boolean; internal?: boolean; author: string; createdAt: string }

/** Conversation view shared by the customer and staff sides of a support request. */
export function SupportThread({ messages, closed, onSend, staff }: { messages: SupportMessage[]; closed?: boolean; onSend: (body: string, internal: boolean) => Promise<void>; staff?: boolean }) {
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSend(body, internal);
      setBody('');
      setInternal(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <ol className="space-y-3">
        {messages.map((m) => (
          <li key={m.id} className={cn('rounded-xl border p-4', m.internal ? 'border-warning/50 bg-warning-soft/40' : m.fromStaff ? 'border-primary/30 bg-primary-soft/30' : 'border-border bg-surface')}>
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="font-medium text-fg">{m.author}</span>
              {m.fromStaff && <Badge tone="info">Staff</Badge>}
              {m.internal && <Badge tone="warning">Internal note</Badge>}
              <span>{formatDate(m.createdAt, true)}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm">{m.body}</p>
          </li>
        ))}
      </ol>
      {closed ? <p className="text-sm text-muted">This request is closed.</p> : (
        <form onSubmit={send} className="space-y-3">
          {error && <Alert tone="danger">{error}</Alert>}
          <Textarea aria-label="Reply" rows={4} required value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a reply" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            {staff ? <Checkbox label="Internal note (not visible to the customer)" checked={internal} onChange={setInternal} /> : <span />}
            <Button type="submit" loading={busy}>Send</Button>
          </div>
        </form>
      )}
    </div>
  );
}
