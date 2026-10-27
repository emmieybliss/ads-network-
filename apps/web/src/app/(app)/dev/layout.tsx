import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

/** Development tools exist only in local/demo builds. */
export default function Layout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_DEMO_MODE !== 'true') notFound();
  return <main className="mx-auto flex min-h-screen max-w-lg items-center px-4 py-10">{children}</main>;
}
