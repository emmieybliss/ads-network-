import Link from 'next/link';
import {
  Activity, ArrowRight, BadgeCheck, BarChart3, BookOpen, CalendarClock, Check, Code2, FileCheck2, Gauge, Globe2, Image as ImageIcon, LayoutPanelTop,
  ListChecks, Lock, Megaphone, MousePointerClick, Newspaper, Rows3, ScanSearch, ShieldCheck, Sparkles, Target, Type, Wallet,
} from 'lucide-react';
import { LinkButton } from '@/components/ui';
import { ProductPreview } from '@/components/marketing/ProductPreview';
import { brand } from '@/lib/brand';
import { formatMicros } from '@/lib/format';
import { publicGet, type ContentItem, type PricingPlan, type PublicConfig } from '@/lib/server-api';

export const revalidate = 60;

function Section({ id, eyebrow, title, intro, children, tinted }: { id?: string; eyebrow: string; title: string; intro?: string; children: React.ReactNode; tinted?: boolean }) {
  return (
    <section id={id} className={tinted ? 'border-y border-border bg-surface' : ''}>
      <div className="mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6 lg:py-24">
        <p className="text-sm font-semibold text-primary">{eyebrow}</p>
        <h2 className="mt-2 max-w-3xl text-3xl font-semibold tracking-tight text-fg sm:text-4xl">{title}</h2>
        {intro && <p className="mt-4 max-w-2xl text-lg text-muted">{intro}</p>}
        <div className="mt-12">{children}</div>
      </div>
    </section>
  );
}

function Feature({ icon: Icon, title, children }: { icon: typeof Target; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow-card)]">
      <div className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary"><Icon className="size-5" aria-hidden /></div>
      <h3 className="mt-4 font-semibold text-fg">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{children}</p>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5 text-[15px] text-fg-2">
      <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> <span>{children}</span>
    </li>
  );
}

export default async function HomePage() {
  const [plans, faqs, config] = await Promise.all([
    publicGet<PricingPlan[]>('/public/pricing'),
    publicGet<ContentItem[]>('/public/content?kind=faq'),
    publicGet<PublicConfig>('/public/config'),
  ]);
  const elig = config?.eligibility;
  const pricing = config?.pricing;
  const currency = pricing?.defaultCurrency ?? 'USD';

  return (
    <>
      {/* 1. Hero */}
      <section className="relative overflow-hidden">
        <div className="hero-grid pointer-events-none absolute inset-0" aria-hidden />
        <div className="glow pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative mx-auto max-w-7xl px-4 pb-16 pt-20 sm:px-6 lg:pt-28">
          <div className="mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-fg-2 shadow-sm">
              <Sparkles className="size-3.5 text-accent" aria-hidden /> An independent advertising network
            </span>
            <h1 className="mt-6 text-4xl font-semibold tracking-tight text-fg sm:text-6xl">One network. More ways to grow.</h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted">
              Launch advertising campaigns, reach audiences across independent publisher websites, and turn quality content into measurable advertising revenue.
            </p>
            <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
              <LinkButton href="/register?type=advertiser" size="lg">Start Advertising <ArrowRight className="size-4" aria-hidden /></LinkButton>
              <LinkButton href="/register?type=publisher" size="lg" variant="secondary">Monetize Your Website</LinkButton>
            </div>
          </div>

          {/* 2. Product interface preview */}
          <div id="platform" className="mx-auto mt-16 max-w-5xl scroll-mt-24">
            <ProductPreview />
          </div>
        </div>
      </section>

      {/* 3. Advertiser campaign management */}
      <Section eyebrow="For advertisers" title="Plan, launch and control campaigns in one place" intro="Set a budget and a schedule, choose where your ads may appear, and see what each placement actually delivered." tinted>
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          <Feature icon={Megaphone} title="Campaign builder">Objectives, start and end dates, lifetime and daily budgets, and CPM, flat-rate or (where enabled) CPC pricing.</Feature>
          <Feature icon={Target} title="Targeting">Country, device, contextual category, keyword, publisher and placement targeting, with exclusions.</Feature>
          <Feature icon={FileCheck2} title="Creative review">Upload image banners or write text ads. Every creative is versioned and reviewed before it serves.</Feature>
          <Feature icon={Wallet} title="Prepaid budgets">Fund your account, reserve budget per campaign, and see every charge in an itemised ledger.</Feature>
        </div>
        <div className="mt-8"><Link href="/advertisers" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">More for advertisers <ArrowRight className="size-4" /></Link></div>
      </Section>

      {/* 4. Publisher monetization */}
      <Section eyebrow="For publishers" title="Earn from your content without giving up control" intro="Add your website, verify that you control it, and place ads where they fit your pages. You decide where ads go; we handle demand, delivery and payment.">
        <div className="grid items-start gap-10 lg:grid-cols-2">
          <ul className="space-y-3.5">
            <Bullet>A small JavaScript tag that works on any website that can include HTML. No plugin required.</Bullet>
            <Bullet>Responsive and fixed-size placements, lazy-loaded so ads never slow your first paint.</Bullet>
            <Bullet>Earnings shown as estimated until the review hold ends, then finalised. Nothing is rounded up.</Bullet>
            <Bullet>Payout requests, payout history and invalid-traffic decisions you can see and appeal.</Bullet>
            <Bullet>Block categories or advertisers you do not want on your pages.</Bullet>
          </ul>
          <div className="rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow-card)]">
            <p className="text-sm font-medium text-fg">Your ad tag</p>
            <pre className="mt-3 overflow-x-auto rounded-xl bg-surface-2 p-4 font-mono text-[12.5px] leading-relaxed text-fg-2">{`<div id="bn-ad-slot-sidebar" data-bn-slot="sidebar"></div>
<script async
  src="https://<your-ad-server>/sdk/ads.js"
  data-site-key="pk_…"
  data-slot="sidebar"></script>`}</pre>
            <p className="mt-3 text-xs text-muted">Generated for you once your site is approved, with your own site key and placement names.</p>
          </div>
        </div>
      </Section>

      {/* 5. Ad formats */}
      <Section id="formats" eyebrow="Ad formats" title="Formats that respect the page" intro="Every ad renders in an isolated container with a visible “Sponsored” label. Advertiser scripts never run on publisher pages." tinted>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
          <Feature icon={ImageIcon} title="Display banners">Standard IAB sizes such as 300×250, 728×90 and 320×50.</Feature>
          <Feature icon={LayoutPanelTop} title="Responsive display">Creatives that scale to the width of the placement.</Feature>
          <Feature icon={Type} title="Text ads">Headline, description and call to action, styled to sit cleanly in content.</Feature>
          <Feature icon={Newspaper} title="In-article">Placed between paragraphs, loaded only as the reader approaches.</Feature>
          <Feature icon={Rows3} title="In-feed sponsored">Clearly labelled sponsored entries in lists and feeds.</Feature>
        </div>
        <p className="mt-6 text-sm text-muted">Native, recommendation widgets and video are on the roadmap. They will carry the same sponsored labelling.</p>
      </Section>

      {/* 6. How the network works */}
      <Section id="how-it-works" eyebrow="How it works" title="From a funded campaign to a verified impression">
        <ol className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {[
            ['Advertisers fund and submit', 'Campaigns and creatives are reviewed against advertising policies before they can serve.'],
            ['Publishers verify and get approved', 'Domain control is verified automatically; the site itself is reviewed for eligibility.'],
            ['The ad server picks an eligible ad', 'Targeting, frequency caps, pacing and budget are checked for every request, and a signed, short-lived token is issued.'],
            ['Valid events are billed and paid', 'Rendered and clicked events are validated, invalid traffic is excluded, and the ledger moves money from advertiser to publisher.'],
          ].map(([t, d], i) => (
            <li key={t} className="rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow-card)]">
              <span className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-fg">{i + 1}</span>
              <h3 className="mt-4 font-semibold">{t}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{d}</p>
            </li>
          ))}
        </ol>
      </Section>

      {/* 7. Domain verification and onboarding */}
      <Section eyebrow="Onboarding" title="Automatic domain verification" intro="Prove you control your website in minutes, with no plugin and no waiting for a person to check it." tinted>
        <div className="grid gap-5 md:grid-cols-3">
          <Feature icon={Globe2} title="DNS TXT record">Add a TXT record at your DNS provider. A DNS proof can also cover your subdomains.</Feature>
          <Feature icon={FileCheck2} title="Verification file">Upload a small text file to your site’s /.well-known/ folder.</Feature>
          <Feature icon={Code2} title="HTML meta tag">Paste one tag into your homepage’s &lt;head&gt;.</Feature>
        </div>
        <div className="mt-8 grid gap-4 rounded-2xl border border-border bg-bg p-5 md:grid-cols-4">
          {['Register and create a publisher account', 'Add a website and choose a verification method', 'Verify, then submit for review with your site details', 'Once approved, create placements and copy your tag'].map((s, i) => (
            <div key={s} className="flex gap-3 text-sm">
              <span className="font-semibold text-primary">{String(i + 1).padStart(2, '0')}</span>
              <span className="text-fg-2">{s}</span>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-muted">Verification proves that you control a hostname. It does not approve a site on its own: every site is reviewed against the publisher requirements.</p>
      </Section>

      {/* 8. Analytics and reporting */}
      <Section eyebrow="Analytics" title="Reports you can reconcile" intro="Every number has a written definition, and every total is calculated from counted events, not averaged percentages.">
        <div className="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
          <div className="grid gap-4 sm:grid-cols-2">
            <Feature icon={BarChart3} title="By date, site and placement">Daily, publisher, placement, creative, device and country breakdowns, exportable to CSV.</Feature>
            <Feature icon={ScanSearch} title="Valid and invalid counts">See what was served, rendered, viewable, invalid and billable, side by side.</Feature>
          </div>
          <dl className="divide-y divide-border rounded-2xl border border-border bg-surface shadow-[var(--shadow-card)]">
            {[
              ['Impression', 'A creative the ad tag reported as rendered, with a valid delivery token. A served ad is not an impression.'],
              ['Viewable impression', 'At least 50% of the ad in view for at least one continuous second.'],
              ['CTR', 'Valid clicks ÷ valid impressions × 100, computed from totals.'],
              ['eCPM', 'Spend ÷ valid impressions × 1,000.'],
              ['RPM', 'Publisher earnings ÷ valid impressions × 1,000.'],
            ].map(([k, v]) => (
              <div key={k} className="grid gap-1 px-5 py-3.5 sm:grid-cols-[170px_1fr]">
                <dt className="text-sm font-medium text-fg">{k}</dt>
                <dd className="text-sm text-muted">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      {/* 9. Campaign optimization */}
      <Section eyebrow="Optimization" title="Delivery that spends your budget sensibly" tinted>
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          <Feature icon={Gauge} title="Pacing">Even or accelerated delivery, with daily limits enforced against real spend.</Feature>
          <Feature icon={CalendarClock} title="Scheduling">Start and end dates in your time zone; campaigns start and finish on their own.</Feature>
          <Feature icon={Activity} title="Frequency caps">Limit how often one visitor sees a campaign, for example three times per 24 hours.</Feature>
          <Feature icon={MousePointerClick} title="Placement insights">Compare placements and publishers, then include or exclude them.</Feature>
        </div>
      </Section>

      {/* 10. Invalid-traffic protection and privacy */}
      <Section eyebrow="Trust" title="Invalid-traffic protection and privacy by default">
        <div className="grid gap-10 lg:grid-cols-2">
          <ul className="space-y-3.5">
            <Bullet>Signed, expiring delivery tokens: an event without a valid token is never billed.</Bullet>
            <Bullet>Duplicate and replay detection, event-sequence checks, known-crawler signals and burst detection.</Bullet>
            <Bullet>Several signals are combined before traffic is classified; a shared IP or a high CTR alone is not treated as fraud.</Bullet>
            <Bullet>Excluded events are reversed in the ledger with a full audit trail, and publishers can appeal.</Bullet>
          </ul>
          <ul className="space-y-3.5">
            <Bullet>Contextual, non-personalized ads by default. No third-party cookies are set by the ad tag.</Bullet>
            <Bullet>A pseudonymous visitor identifier is used only when the site’s consent tool allows it.</Bullet>
            <Bullet>IP addresses are hashed with a daily salt and never stored in raw form.</Bullet>
            <Bullet>We respect consent decisions, browser privacy settings and ad blockers. We do not try to bypass them.</Bullet>
          </ul>
        </div>
      </Section>

      {/* 11. Publisher eligibility requirements */}
      <Section id="requirements" eyebrow="Publisher requirements" title="What we look for in a publisher site" tinted>
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          <Feature icon={BadgeCheck} title="Site ownership">You verify control of the hostname with DNS, a file or a meta tag.</Feature>
          {(elig?.requireOriginalContent ?? true) && <Feature icon={BookOpen} title="Original, useful content">Content you create or have the rights to publish, with genuine value to readers.</Feature>}
          {(elig?.requireTrafficIntegrity ?? true) && <Feature icon={ShieldCheck} title="Traffic integrity">No purchased bot traffic, incentivised clicks, or auto-refreshing ads.</Feature>}
          {(elig?.requirePrivacyPolicy ?? true) && <Feature icon={Lock} title="Privacy compliance">A published privacy policy, and a consent tool where the law requires one.</Feature>}
          {(elig?.requireContactInformation ?? true) && <Feature icon={ListChecks} title="Contact information">A way for readers and for us to reach the site owner.</Feature>}
          <Feature icon={Activity} title="Traffic requirements">
            {elig?.minMonthlyPageviews ? `At least ${elig.minMonthlyPageviews.toLocaleString()} monthly page views, as set by the network operator.` : 'No minimum traffic threshold is currently set. The network operator may set one.'}
          </Feature>
        </div>
        <div className="mt-8"><Link href="/publisher-requirements" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">Read the full requirements and prohibited content <ArrowRight className="size-4" /></Link></div>
      </Section>

      {/* 12. Pricing and commercial models */}
      <Section id="pricing" eyebrow="Pricing" title="Simple commercial models" intro="No setup fees are built into the platform. Rates and minimums are set by the network operator and shown here as they are configured.">
        <div className="grid gap-5 md:grid-cols-3">
          {[
            { name: 'CPM', on: pricing?.cpmEnabled ?? true, desc: 'Pay per thousand valid, rendered impressions.', min: pricing ? `Minimum rate ${formatMicros(pricing.minCpmMicros, currency)} per thousand` : null },
            { name: 'Flat-rate sponsorship', on: pricing?.flatEnabled ?? true, desc: 'A fixed price for a placement over a date range, spread evenly per day.', min: null },
            { name: 'CPC', on: pricing?.cpcEnabled ?? false, desc: 'Pay per valid click. Enabled once click validation is in place for the network.', min: pricing?.cpcEnabled ? `Minimum ${formatMicros(pricing.minCpcMicros, currency)} per click` : null },
          ].map((m) => (
            <div key={m.name} className="rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow-card)]">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{m.name}</h3>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${m.on ? 'bg-success-soft text-success' : 'bg-surface-2 text-muted'}`}>{m.on ? 'Available' : 'Not yet enabled'}</span>
              </div>
              <p className="mt-2 text-sm text-muted">{m.desc}</p>
              {m.min && <p className="mt-3 text-sm text-fg-2">{m.min}</p>}
            </div>
          ))}
        </div>
        {plans && plans.length > 0 ? (
          <div className="mt-8 grid gap-5 md:grid-cols-2">
            {plans.map((p) => (
              <div key={`${p.audience}-${p.name}`} className={`rounded-2xl border bg-surface p-6 shadow-[var(--shadow-card)] ${p.highlighted ? 'border-primary' : 'border-border'}`}>
                <p className="text-xs font-semibold uppercase tracking-wide text-primary">{p.audience === 'advertiser' ? 'Advertisers' : 'Publishers'}</p>
                <h3 className="mt-1 text-xl font-semibold">{p.name}</h3>
                <p className="mt-1 text-sm text-muted">{p.summary}</p>
                <p className="mt-4 text-2xl font-semibold tracking-tight">{p.price_label}</p>
                <ul className="mt-4 space-y-2">{p.features.map((f) => <Bullet key={f}>{f}</Bullet>)}</ul>
                <LinkButton href={`/register?type=${p.audience}`} className="mt-6 w-full" variant={p.highlighted ? 'primary' : 'secondary'}>{p.cta_label}</LinkButton>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-8 rounded-xl border border-dashed border-border p-5 text-sm text-muted">Commercial terms have not been published yet. The network operator sets them in the admin control center.</p>
        )}
      </Section>

      {/* 13. FAQs */}
      <Section id="faq" eyebrow="FAQ" title="Questions, answered" tinted>
        {faqs && faqs.length > 0 ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {faqs.map((f) => (
              <details key={f.slug} className="group rounded-xl border border-border bg-bg p-4 open:bg-surface">
                <summary className="cursor-pointer list-none font-medium text-fg marker:content-none">
                  <span className="flex items-center justify-between gap-3">{f.title}<span className="text-muted transition-transform group-open:rotate-45">+</span></span>
                </summary>
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted">{f.body}</p>
              </details>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">Frequently asked questions are managed in the admin control center and will appear here once published.</p>
        )}
      </Section>

      {/* 14. Documentation and developer resources */}
      <Section eyebrow="Developers" title="Documentation and developer resources">
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {[
            [BookOpen, 'Publisher integration guide', '/docs#publishers', 'Placing the tag, multiple placements, consent and troubleshooting.'],
            [Megaphone, 'Advertiser guide', '/docs#advertisers', 'Campaign setup, creative specifications and policies.'],
            [Code2, 'API reference', '/docs/api', 'The versioned REST API under /api/v1, described with OpenAPI.'],
            [ShieldCheck, 'Measurement and privacy', '/docs#measurement', 'How impressions, viewability and invalid traffic are measured.'],
          ].map(([Icon, t, href, d]) => {
            const I = Icon as typeof BookOpen;
            return (
              <Link key={t as string} href={href as string} className="group rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow-card)] transition-colors hover:border-primary">
                <I className="size-5 text-primary" aria-hidden />
                <h3 className="mt-3 font-semibold group-hover:text-primary">{t as string}</h3>
                <p className="mt-1.5 text-sm text-muted">{d as string}</p>
              </Link>
            );
          })}
        </div>
      </Section>

      {/* 15. Registration CTA */}
      <section className="px-4 pb-24 sm:px-6">
        <div className="relative mx-auto max-w-7xl overflow-hidden rounded-3xl bg-[linear-gradient(135deg,var(--primary),color-mix(in_srgb,var(--primary)_55%,var(--accent)))] px-6 py-16 text-center sm:px-12">
          <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Ready when you are</h2>
          <p className="mx-auto mt-3 max-w-xl text-white/85">Create an account in a couple of minutes. Advertisers can draft campaigns right away; publishers can add and verify a site the same day.</p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/register?type=advertiser" className="inline-flex h-11 items-center justify-center rounded-lg bg-white px-5 text-[15px] font-medium text-[#1b1a4a] hover:bg-white/90">Start Advertising</Link>
            <Link href="/register?type=publisher" className="inline-flex h-11 items-center justify-center rounded-lg border border-white/40 px-5 text-[15px] font-medium text-white hover:bg-white/10">Monetize Your Website</Link>
          </div>
          <p className="mt-6 text-xs text-white/70">{brand.productName} by {brand.companyName}</p>
        </div>
      </section>
      {/* 16. Footer is rendered by the marketing layout. */}
    </>
  );
}
