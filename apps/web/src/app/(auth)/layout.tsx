import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '@/components/ui';
import { brand } from '@/lib/brand';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="hero-grid pointer-events-none absolute inset-0" aria-hidden />
      <div className="glow pointer-events-none absolute inset-0" aria-hidden />
      <header className="relative mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Link href="/"><Logo name={brand.shortName} /></Link>
        <Link href="/" className="text-sm text-muted hover:text-fg">Back to site</Link>
      </header>
      <main className="relative flex flex-1 items-start justify-center px-4 pb-16 pt-6 sm:pt-12">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
