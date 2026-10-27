import type { ReactNode } from 'react';

export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <div className="rounded-2xl border border-border bg-surface p-6 shadow-[var(--shadow-pop)] sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
      {footer && <div className="mt-5 text-center text-sm text-muted">{footer}</div>}
    </>
  );
}

/** Where to go after sign-in: an internal path from ?next=, or the right portal. */
export function landingPath(user: { platformRole: string | null; organizations: Array<{ type: string }> }, next?: string | null): string {
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  if (user.platformRole) return '/admin';
  const first = user.organizations[0];
  if (!first) return '/onboarding';
  return first.type === 'advertiser' ? '/advertiser' : '/publisher';
}
