'use client';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, Field, Input, Modal } from './ui';
import { errorMessage, post, setStepUpHandler } from '@/lib/api';
import { useSession } from '@/lib/session';

/** Asks the signed-in person to confirm their password (and authenticator code) before a sensitive action is retried. */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    setStepUpHandler(() => new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setPassword('');
      setTotp('');
      setError(null);
      setOpen(true);
    }));
    return () => setStepUpHandler(null);
  }, []);

  const finish = (ok: boolean) => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/step-up', { password, totp: totp || undefined });
      finish(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {children}
      <Modal open={open} onClose={() => finish(false)} title="Confirm it’s you" footer={<><Button variant="secondary" onClick={() => finish(false)}>Cancel</Button><Button type="submit" form="stepup" loading={busy}>Confirm</Button></>}>
        <form id="stepup" onSubmit={submit} className="space-y-4">
          <p className="text-sm text-fg-2">This action is sensitive. Enter your password to continue. Confirmation lasts a few minutes.</p>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Password" htmlFor="su-pw"><Input id="su-pw" type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {me?.mfaEnabled && <Field label="Authenticator code" htmlFor="su-totp"><Input id="su-totp" inputMode="numeric" pattern="\d{6}" required value={totp} onChange={(e) => setTotp(e.target.value)} /></Field>}
        </form>
      </Modal>
    </>
  );
}
