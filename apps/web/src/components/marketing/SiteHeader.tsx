'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { LinkButton, Logo } from '@/components/ui';
import { brand } from '@/lib/brand';

const NAV = [
  { href: '/#platform', label: 'Platform' },
  { href: '/advertisers', label: 'For Advertisers' },
  { href: '/publishers', label: 'For Publishers' },
  { href: '/#formats', label: 'Ad Formats' },
  { href: '/publisher-requirements', label: 'Publisher Requirements' },
  { href: '/#pricing', label: 'Pricing' },
  { href: '/docs', label: 'Documentation' },
  { href: '/resources', label: 'Resources' },
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" aria-label={`${brand.productName} home`}><Logo name={brand.shortName} /></Link>
        <nav className="hidden items-center gap-0.5 xl:flex" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="rounded-md px-2.5 py-1.5 text-[13.5px] text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg">{n.label}</Link>
          ))}
        </nav>
        <div className="hidden items-center gap-2 xl:flex">
          <LinkButton href="/login" variant="ghost">Sign In</LinkButton>
          <LinkButton href="/register">Get Started</LinkButton>
        </div>
        <button className="rounded-md p-2 text-fg xl:hidden" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Menu">
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>
      {open && (
        <nav className="border-t border-border bg-surface px-4 py-3 xl:hidden" aria-label="Main">
          <div className="grid gap-1">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} onClick={() => setOpen(false)} className="rounded-md px-3 py-2 text-sm text-fg-2 hover:bg-surface-2">{n.label}</Link>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <LinkButton href="/login" variant="secondary">Sign In</LinkButton>
            <LinkButton href="/register">Get Started</LinkButton>
          </div>
        </nav>
      )}
    </header>
  );
}
