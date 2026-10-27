import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { brand } from '@/lib/brand';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(brand.siteUrl),
  title: { default: `${brand.productName} — advertising for independent publishers`, template: `%s · ${brand.productName}` },
  description: 'Launch advertising campaigns, reach audiences across independent publisher websites, and turn quality content into measurable advertising revenue.',
  applicationName: brand.productName,
  openGraph: { type: 'website', siteName: brand.productName },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0c0d1a' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-fg">{children}</body>
    </html>
  );
}
