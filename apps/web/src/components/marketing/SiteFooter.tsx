import Link from 'next/link';
import { Logo } from '@/components/ui';
import { brand } from '@/lib/brand';

const COLS = [
  { title: 'Platform', links: [['/#platform', 'Overview'], ['/#formats', 'Ad formats'], ['/#how-it-works', 'How it works'], ['/#pricing', 'Pricing']] },
  { title: 'Advertisers', links: [['/advertisers', 'Advertise with us'], ['/register?type=advertiser', 'Create an account'], [brand.legal.advertiserPolicyUrl, 'Advertiser policies']] },
  { title: 'Publishers', links: [['/publishers', 'Monetize your site'], ['/publisher-requirements', 'Requirements'], [brand.legal.publisherPolicyUrl, 'Publisher policies']] },
  { title: 'Resources', links: [['/docs', 'Documentation'], ['/docs/api', 'API reference'], ['/resources', 'Resources'], ['/report-abuse', 'Report an ad or site']] },
  { title: 'Legal', links: [[brand.legal.termsUrl, 'Terms of service'], [brand.legal.privacyUrl, 'Privacy policy'], ['/legal/cookies', 'Cookies and tracking']] },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[1.3fr_repeat(5,1fr)]">
          <div>
            <Logo name={brand.productName} />
            <p className="mt-3 max-w-xs text-sm text-muted">An independent advertising network connecting advertisers with quality publisher websites.</p>
            <p className="mt-4 text-sm text-muted">
              Contact: <a className="text-fg-2 underline-offset-2 hover:underline" href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>
            </p>
          </div>
          {COLS.map((c) => (
            <div key={c.title}>
              <h3 className="text-sm font-semibold text-fg">{c.title}</h3>
              <ul className="mt-3 space-y-2">
                {c.links.map(([href, label]) => (
                  <li key={href}><Link href={href} className="text-sm text-muted hover:text-fg">{label}</Link></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6 text-xs text-muted">
          <p>© {new Date().getFullYear()} {brand.companyName}. {brand.productName} is a product of {brand.companyName}.</p>
          <p>Ads are always labelled as sponsored. We do not sell personal data.</p>
        </div>
      </div>
    </footer>
  );
}
