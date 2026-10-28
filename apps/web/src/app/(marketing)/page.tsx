import Link from 'next/link';
import {
  Activity, ArrowRight, BadgeCheck, BookOpen, CalendarClock, Check, CheckCircle2, Code2, FileCheck2, FileCode2, Fingerprint, Gauge, Globe2, Layers,
  ListChecks, Lock, Megaphone, ScanSearch, ShieldCheck, Sparkles, Target, Wallet, Wand2,
} from 'lucide-react';
import { clsx as cn } from 'clsx';
import { LinkButton } from '@/components/ui';
import { AudienceTabs } from '@/components/marketing/AudienceTabs';
import { FormatThumb, NativeAdCard, PublisherDashboardMock, ReportsMock } from '@/components/marketing/mockups';
import { brand } from '@/lib/brand';
import { formatMicros } from '@/lib/format';
import { publicGet, type ContentItem, type PricingPlan, type PublicConfig } from '@/lib/server-api';

export const revalidate = 60;

function Heading({ eyebrow, title, intro, center, className }: { eyebrow: string; title: React.ReactNode; intro?: string; center?: boolean; className?: string }) {
  return (
    <div className={cn(center && 'mx-auto text-center', 'max-w-3xl', className)}>
      <p className="text-sm font-semibold text-primary">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-fg sm:text-[44px] sm:leading-[1.1]">{title}</h2>
      {intro && <p className={cn('mt-5 text-lg leading-relaxed text-muted', center && 'mx-auto max-w-2xl')}>{intro}</p>}
    </div>
  );
}

function Container({ children, className, id }: { children: React.ReactNode; className?: string; id?: string }) {
  return <div id={id} className={cn('mx-auto max-w-7xl scroll-mt-20 px-4 sm:px-6', className)}>{children}</div>;
}

function BentoCard({ icon: Icon, title, children, visual, className }: { icon: typeof Target; title: string; children: React.ReactNode; visual?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('group relative flex flex-col overflow-hidden rounded-2xl border border-border bg-surface p-6 shadow-[var(--shadow-card)] transition-shadow hover:shadow-[var(--shadow-pop)]', className)}>
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary-soft text-primary"><Icon className="size-4" aria-hidden /></span>
        <h3 className="font-semibold text-fg">{title}</h3>
      </div>
      <p className="mt-3 text-[15px] leading-relaxed text-muted">{children}</p>
      {visual && <div className="mt-6 flex-1">{visual}</div>}
    </div>
  );
}

const FORMATS = [
  ['display', 'Display banners', 'Standard IAB sizes such as 300×250, 728×90 and 320×50, or responsive.'],
  ['in-article', 'In-article', 'Between paragraphs, placed by hand or by auto ads, loaded as the reader approaches.'],
  ['native', 'Native', 'Image, headline and description styled like the page, always marked “Sponsored”.'],
  ['in-feed', 'In-feed', 'Clearly labelled sponsored entries inside lists and feeds.'],
  ['anchor', 'Sticky anchor', 'A slim bar fixed to the bottom of the screen, with reserved space so content is never covered.'],
  ['rail', 'Side rail', 'A tall unit beside the content on wide screens, such as 160×600.'],
  ['interstitial', 'Interstitial', 'Full-screen between page views, closable at once and frequency-capped.'],
  ['text', 'Text ads', 'Headline, description and call to action that sit cleanly in content.'],
] as const;

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
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="mesh pointer-events-none absolute -right-32 -top-24 h-[900px] w-[1000px] opacity-90" aria-hidden />
        <div className="dot-grid pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,black,transparent_70%)] opacity-60" aria-hidden />
        <Container className="relative grid items-center gap-14 pb-20 pt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:pb-32 lg:pt-24">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/80 px-3 py-1 text-xs font-medium text-fg-2 shadow-sm backdrop-blur">
              <Sparkles className="size-3.5 text-accent" aria-hidden /> Advertising for the independent web
            </span>
            <h1 className="mt-6 text-[40px] font-semibold leading-[1.05] tracking-[-0.035em] text-fg sm:text-6xl lg:text-[60px]">
              Ads that pay publishers and <span className="text-gradient">perform for brands.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted sm:text-xl">
              {brand.productName} connects advertisers with quality independent websites. Launch campaigns in minutes, or add one tag to your site and start earning.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <LinkButton href="/register?type=advertiser" size="lg" className="shadow-[0_8px_24px_-8px_var(--primary)]">Start advertising <ArrowRight className="size-4" aria-hidden /></LinkButton>
              <LinkButton href="/register?type=publisher" size="lg" variant="secondary">Monetize your website</LinkButton>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-sm text-fg-2">
              {['One script tag, no plugin', 'Every ad reviewed', 'Prepaid, itemised billing'].map((t) => (
                <li key={t} className="flex items-center gap-1.5"><CheckCircle2 className="size-4 text-success" aria-hidden />{t}</li>
              ))}
            </ul>
          </div>
          <div id="platform" className="relative scroll-mt-24 lg:-mr-6 xl:-mr-16">
            <PublisherDashboardMock />
            <NativeAdCard className="float-slow absolute -bottom-10 -left-6 hidden sm:block lg:-left-16" />
            <div className="float-slower absolute -bottom-12 right-6 hidden w-[210px] rounded-xl border border-border bg-surface p-3.5 shadow-[var(--shadow-pop)] sm:block lg:right-10">
              <div className="flex items-center justify-between text-[11px] text-muted"><span>Available for payout</span><Wallet className="size-3.5" aria-hidden /></div>
              <p className="tabular mt-1 text-xl font-semibold tracking-tight">$842.10</p>
              <div className="mt-2 flex items-center justify-between"><span className="text-[10px] text-muted">After the review hold</span><span className="rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-primary-fg">Request payout</span></div>
            </div>
          </div>
        </Container>
      </section>

      {/* Capability strip: product facts, not customer claims */}
      <section className="border-y border-border bg-surface">
        <Container className="grid grid-cols-2 gap-x-6 gap-y-5 py-8 md:grid-cols-3 lg:grid-cols-6">
          {[
            [Code2, 'One async tag'],
            [Layers, '8 ad formats'],
            [Fingerprint, 'TCF v2.2 · GPP · GPC'],
            [FileCode2, 'ads.txt & sellers.json'],
            [ScanSearch, 'Invalid-traffic filtering'],
            [Wallet, 'Double-entry ledger'],
          ].map(([Icon, label]) => {
            const I = Icon as typeof Code2;
            return <div key={label as string} className="flex items-center gap-2.5 text-sm font-medium text-fg-2"><I className="size-4.5 shrink-0 text-muted" aria-hidden />{label as string}</div>;
          })}
        </Container>
      </section>

      {/* Audiences */}
      <section className="overflow-hidden py-24 lg:py-32">
        <Container>
          <Heading eyebrow="One platform, both sides" title="Built for the people who buy ads, the people who show them, and the quality in between." className="max-w-4xl" />
          <div className="mt-12"><AudienceTabs /></div>
        </Container>
      </section>

      {/* Bento: capabilities */}
      <section className="border-y border-border bg-surface-2/60 py-24 lg:py-32">
        <Container>
          <Heading eyebrow="Platform" title="Everything a modern ad network needs, already built in" intro="From the first verification check to the final payout, each step is part of the same system, with the same rules and the same audit trail." />
          <div className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-6">
            <BentoCard icon={Target} title="Precise targeting" className="lg:col-span-4" visual={
              <div className="flex flex-wrap gap-2">
                {[['Country', 'United States'], ['Device', 'Mobile'], ['Category', 'Home & garden'], ['Keyword', 'hiking'], ['Placement', 'In-article'], ['Exclude', 'Gambling']].map(([k, v]) => (
                  <span key={k} className={cn('flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px]', k === 'Exclude' ? 'border-danger/30 bg-danger-soft text-danger' : 'border-border bg-bg')}>
                    <span className="text-muted">{k}</span><span className="font-medium">{v}</span>
                  </span>
                ))}
              </div>
            }>Country, device, contextual category, keyword, publisher and placement targeting, with exclusions on every dimension.</BentoCard>
            <BentoCard icon={Gauge} title="Pacing" className="lg:col-span-2" visual={
              <div>
                <div className="flex items-end gap-1">{[30, 34, 33, 36, 35, 37, 36, 38, 37, 39].map((h, i) => <div key={i} className="flex-1 rounded-t bg-primary/70" style={{ height: h * 1.6 }} />)}</div>
                <p className="mt-2 text-xs text-muted">Even delivery, daily limit enforced</p>
              </div>
            }>Even or accelerated delivery, checked against real spend.</BentoCard>
            <BentoCard icon={Globe2} title="Automatic domain verification" className="lg:col-span-2" visual={
              <div className="space-y-2">
                {['DNS TXT record', '/.well-known/ file', 'HTML meta tag'].map((m, i) => (
                  <div key={m} className="flex items-center justify-between rounded-lg border border-border bg-bg px-3 py-2 text-[13px]">
                    <span>{m}</span>{i === 0 ? <span className="flex items-center gap-1 text-xs font-medium text-success"><Check className="size-3.5" aria-hidden />Verified</span> : <span className="text-xs text-muted">Available</span>}
                  </div>
                ))}
              </div>
            }>Prove you control a site in minutes, with no plugin and no waiting.</BentoCard>
            <BentoCard icon={FileCheck2} title="Creative review" className="lg:col-span-2" visual={
              <ol className="relative space-y-3 border-l border-border pl-4 text-[13px]">
                {[['Uploaded', 'v3 · 300×250', 'text-muted'], ['In review', 'Policy checks', 'text-warning'], ['Approved', 'Ready to serve', 'text-success']].map(([s, d, c]) => (
                  <li key={s} className="relative"><span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-border-strong" /><span className={cn('font-medium', c)}>{s}</span> <span className="text-muted">· {d}</span></li>
                ))}
              </ol>
            }>Every creative is versioned and reviewed before it can serve.</BentoCard>
            <BentoCard icon={Fingerprint} title="Consent signals" className="lg:col-span-2" visual={
              <div className="grid grid-cols-2 gap-2">
                {['TCF v2.2', 'GPP', 'US Privacy', 'GPC'].map((s) => <span key={s} className="rounded-lg border border-border bg-bg px-3 py-2 text-center text-[13px] font-medium">{s}</span>)}
              </div>
            }>The tag reads the site’s consent signals and serves non-personalized ads when it should.</BentoCard>
            <BentoCard icon={Wand2} title="Auto ads" className="lg:col-span-3" visual={
              <div className="rounded-lg border border-border bg-bg p-3">
                <div className="space-y-1.5"><div className="h-1.5 w-[90%] rounded-full bg-border" /><div className="h-1.5 w-[75%] rounded-full bg-border" /></div>
                <div className="my-2.5 flex h-9 items-center justify-center rounded-md border border-dashed border-primary/60 bg-primary-soft text-[11px] font-medium text-primary">In-article ad inserted after paragraph 3</div>
                <div className="space-y-1.5"><div className="h-1.5 w-[85%] rounded-full bg-border" /><div className="h-1.5 w-[60%] rounded-full bg-border" /></div>
              </div>
            }>Turn on automatic in-article placements and set how far apart ads must be. You stay in control of density.</BentoCard>
            <BentoCard icon={FileCode2} title="ads.txt and sellers.json" className="lg:col-span-3" visual={
              <pre className="overflow-x-auto rounded-lg bg-[#0f1124] p-3.5 font-mono text-[12px] leading-relaxed text-[#c9cbe3]"><span className="text-[#8b85ff]"># ads.txt for your site</span>{`
<ad-server-domain>, pub-xxxxxxxx, DIRECT
`}<span className="text-[#8b85ff]"># generated per publisher, ready to copy</span></pre>
            }>Supply-chain transparency files are generated for each publisher and published for the network.</BentoCard>
          </div>
        </Container>
      </section>

      {/* Ad formats */}
      <section id="formats" className="scroll-mt-16 py-24 lg:py-32">
        <Container>
          <div className="flex flex-wrap items-end justify-between gap-6">
            <Heading eyebrow="Ad formats" title="Formats that respect the page" intro="Every ad renders in an isolated container with a visible “Sponsored” label. Advertiser scripts never run on publisher pages." />
            <Link href="/docs#publishers" className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary">Format specifications <ArrowRight className="size-4" aria-hidden /></Link>
          </div>
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {FORMATS.map(([kind, title, desc]) => (
              <div key={kind} className="rounded-2xl border border-border bg-surface p-3 shadow-[var(--shadow-card)] transition-transform hover:-translate-y-0.5">
                <FormatThumb kind={kind} />
                <div className="px-2 pb-2 pt-4">
                  <h3 className="font-semibold">{title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </Container>
      </section>

      {/* Analytics, dark band */}
      <section className="scheme-dark relative overflow-hidden bg-bg py-24 text-fg lg:py-32">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_60%_at_80%_0%,color-mix(in_srgb,var(--primary)_28%,transparent),transparent_70%)]" aria-hidden />
        <Container className="relative">
          <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div>
              <Heading eyebrow="Analytics" title="Reporting you can reconcile, down to the page" intro="Every metric has a written definition, and every total is calculated from counted events. No averaged percentages, no rounding up." />
              <dl className="mt-10 grid gap-x-8 gap-y-6 sm:grid-cols-2">
                {[
                  ['Impression', 'A creative the tag reported as rendered, with a valid delivery token.'],
                  ['Viewable', 'At least 50% of the ad in view for one continuous second.'],
                  ['Page RPM', 'Earnings ÷ page views × 1,000, per page and per site.'],
                  ['Invalid traffic', 'Counted and shown, never billed, with appeals for publishers.'],
                ].map(([k, v]) => (
                  <div key={k} className="border-l-2 border-primary/60 pl-4">
                    <dt className="font-semibold">{k}</dt>
                    <dd className="mt-1 text-sm leading-relaxed text-muted">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <ReportsMock />
          </div>
        </Container>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="scroll-mt-16 py-24 lg:py-32">
        <Container>
          <Heading center eyebrow="How it works" title="From a funded campaign to a verified, paid impression" />
          <ol className="relative mt-16 grid gap-10 md:grid-cols-4 md:gap-6">
            <div className="absolute left-0 right-0 top-5 hidden h-px bg-[linear-gradient(90deg,transparent,var(--border-strong)_15%,var(--border-strong)_85%,transparent)] md:block" aria-hidden />
            {[
              [Megaphone, 'Advertisers fund and submit', 'Campaigns and creatives are reviewed against advertising policies before they can serve.'],
              [BadgeCheck, 'Publishers verify and get approved', 'Domain control is verified automatically; the site is then reviewed for eligibility.'],
              [Target, 'The ad server picks an eligible ad', 'Targeting, frequency caps, pacing and budget are checked, and a signed, short-lived token is issued.'],
              [Wallet, 'Valid events are billed and paid', 'Invalid traffic is excluded, and the ledger moves money from advertiser to publisher.'],
            ].map(([Icon, t, d], i) => {
              const I = Icon as typeof Target;
              return (
                <li key={t as string} className="relative text-center md:px-2">
                  <span className="relative mx-auto flex size-10 items-center justify-center rounded-full border border-border bg-surface text-primary shadow-[var(--shadow-card)]"><I className="size-4.5" aria-hidden /></span>
                  <p className="mt-5 text-xs font-semibold tracking-wider text-muted">STEP {i + 1}</p>
                  <h3 className="mt-1 font-semibold">{t as string}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{d as string}</p>
                </li>
              );
            })}
          </ol>
        </Container>
      </section>

      {/* Trust, privacy and requirements */}
      <section id="requirements" className="scroll-mt-16 border-y border-border bg-surface py-24 lg:py-32">
        <Container>
          <div className="grid gap-14 lg:grid-cols-2">
            <div>
              <Heading eyebrow="Trust and privacy" title="Quality traffic and privacy by default" />
              <div className="mt-10 grid gap-6 sm:grid-cols-2">
                {[
                  [ShieldCheck, 'Signed delivery tokens', 'An event without a valid, unexpired token is never billed.'],
                  [ScanSearch, 'Multi-signal IVT checks', 'Duplicates, replays, crawlers and bursts are combined before anything is classified.'],
                  [Lock, 'No third-party cookies', 'Contextual, non-personalized ads by default; IPs are hashed with a daily salt.'],
                  [Activity, 'A full audit trail', 'Excluded events are reversed in the ledger, and publishers can appeal.'],
                ].map(([Icon, t, d]) => {
                  const I = Icon as typeof Lock;
                  return (
                    <div key={t as string}>
                      <I className="size-5 text-primary" aria-hidden />
                      <h3 className="mt-3 font-semibold">{t as string}</h3>
                      <p className="mt-1.5 text-sm leading-relaxed text-muted">{d as string}</p>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="rounded-3xl border border-border bg-bg p-7 sm:p-9">
              <p className="text-sm font-semibold text-primary">Publisher requirements</p>
              <h3 className="mt-2 text-2xl font-semibold tracking-tight">What we look for in a site</h3>
              <ul className="mt-6 divide-y divide-border">
                {[
                  [BadgeCheck, 'Verified site ownership', true],
                  [BookOpen, 'Original, useful content', elig?.requireOriginalContent ?? true],
                  [ShieldCheck, 'No purchased or incentivised traffic', elig?.requireTrafficIntegrity ?? true],
                  [Lock, 'A published privacy policy and consent tool where required', elig?.requirePrivacyPolicy ?? true],
                  [ListChecks, 'Contact information for the site owner', elig?.requireContactInformation ?? true],
                ].filter(([, , on]) => on).map(([Icon, t]) => {
                  const I = Icon as typeof Lock;
                  return <li key={t as string} className="flex items-center gap-3 py-3 text-[15px] text-fg-2"><I className="size-4 shrink-0 text-muted" aria-hidden />{t as string}</li>;
                })}
                <li className="flex items-center gap-3 py-3 text-[15px] text-fg-2">
                  <Activity className="size-4 shrink-0 text-muted" aria-hidden />
                  {elig?.minMonthlyPageviews ? `At least ${elig.minMonthlyPageviews.toLocaleString()} monthly page views` : 'No minimum traffic threshold is currently set'}
                </li>
              </ul>
              <Link href="/publisher-requirements" className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-primary">Full requirements and prohibited content <ArrowRight className="size-4" aria-hidden /></Link>
            </div>
          </div>
        </Container>
      </section>

      {/* Pricing */}
      <section id="pricing" className="scroll-mt-16 py-24 lg:py-32">
        <Container>
          <Heading center eyebrow="Pricing" title="Simple, transparent commercial models" intro="No setup fees are built into the platform. Rates and minimums are set by the network operator and shown here as configured." />
          <div className="mx-auto mt-14 grid max-w-5xl gap-5 md:grid-cols-3">
            {[
              { name: 'CPM', on: pricing?.cpmEnabled ?? true, desc: 'Pay per thousand valid, rendered impressions.', min: pricing ? `Minimum ${formatMicros(pricing.minCpmMicros, currency)} per thousand` : null },
              { name: 'Flat-rate sponsorship', on: pricing?.flatEnabled ?? true, desc: 'A fixed price for a placement over a date range, spread evenly per day.', min: null },
              { name: 'CPC', on: pricing?.cpcEnabled ?? false, desc: 'Pay per valid click, once click validation is enabled for the network.', min: pricing?.cpcEnabled ? `Minimum ${formatMicros(pricing.minCpcMicros, currency)} per click` : null },
            ].map((m) => (
              <div key={m.name} className="rounded-2xl border border-border bg-surface p-6 shadow-[var(--shadow-card)]">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-lg font-semibold">{m.name}</h3>
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', m.on ? 'bg-success-soft text-success' : 'bg-surface-2 text-muted')}>{m.on ? 'Available' : 'Not yet enabled'}</span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-muted">{m.desc}</p>
                {m.min && <p className="mt-4 border-t border-border pt-4 text-sm font-medium text-fg-2">{m.min}</p>}
              </div>
            ))}
          </div>
          {plans && plans.length > 0 && (
            <div className={cn('mx-auto mt-6 grid max-w-5xl gap-5 md:grid-cols-2', plans.length % 3 === 0 && 'lg:grid-cols-3')}>
              {plans.map((p) => (
                <div key={`${p.audience}-${p.name}`} className={cn('relative rounded-2xl border bg-surface p-7 shadow-[var(--shadow-card)]', p.highlighted ? 'border-primary shadow-[0_0_0_1px_var(--primary),var(--shadow-pop)]' : 'border-border')}>
                  <p className="text-xs font-semibold uppercase tracking-wider text-primary">{p.audience === 'advertiser' ? 'Advertisers' : 'Publishers'}</p>
                  <h3 className="mt-1.5 text-xl font-semibold">{p.name}</h3>
                  <p className="mt-1 text-sm text-muted">{p.summary}</p>
                  <p className="mt-5 text-3xl font-semibold tracking-tight">{p.price_label}</p>
                  <ul className="mt-5 space-y-2.5">
                    {p.features.map((f) => <li key={f} className="flex gap-2.5 text-[15px] text-fg-2"><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />{f}</li>)}
                  </ul>
                  <LinkButton href={`/register?type=${p.audience}`} className="mt-7 w-full" variant={p.highlighted ? 'primary' : 'secondary'}>{p.cta_label}</LinkButton>
                </div>
              ))}
            </div>
          )}
        </Container>
      </section>

      {/* FAQ */}
      <section id="faq" className="scroll-mt-16 border-t border-border bg-surface-2/60 py-24 lg:py-32">
        <Container className="grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
          <Heading eyebrow="FAQ" title="Questions, answered" intro="Can’t find what you need? The documentation covers integration, policies and measurement in detail." />
          {faqs && faqs.length > 0 ? (
            <div className="divide-y divide-border rounded-2xl border border-border bg-surface shadow-[var(--shadow-card)]">
              {faqs.map((f) => (
                <details key={f.slug} className="group px-6 py-5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-fg marker:content-none">
                    {f.title}<span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-muted transition-transform group-open:rotate-45">+</span>
                  </summary>
                  <p className="mt-3 whitespace-pre-line text-[15px] leading-relaxed text-muted">{f.body}</p>
                </details>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">Frequently asked questions are managed in the admin control center and will appear here once published.</p>
          )}
        </Container>
      </section>

      {/* Developers */}
      <section className="py-24 lg:py-32">
        <Container className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <Heading eyebrow="Developers" title="One tag. A versioned API. No surprises." intro="Place ads with a single asynchronous script, and automate everything else through the REST API described with OpenAPI." />
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {[
                [BookOpen, 'Publisher integration guide', '/docs#publishers'],
                [Megaphone, 'Advertiser guide', '/docs#advertisers'],
                [Code2, 'API reference', '/docs/api'],
                [ShieldCheck, 'Measurement and privacy', '/docs#measurement'],
              ].map(([Icon, t, href]) => {
                const I = Icon as typeof Code2;
                return (
                  <Link key={t as string} href={href as string} className="group flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm font-medium shadow-[var(--shadow-card)] transition-colors hover:border-primary">
                    <I className="size-4 text-primary" aria-hidden /><span className="flex-1">{t as string}</span><ArrowRight className="size-4 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </Link>
                );
              })}
            </div>
          </div>
          <div className="overflow-hidden rounded-2xl border border-[#2a2d4a] bg-[#0f1124] shadow-[var(--shadow-pop)]">
            <div className="flex items-center gap-2 border-b border-[#2a2d4a] px-4 py-2.5 text-xs text-[#9497b8]">
              <CalendarClock className="size-3.5" aria-hidden /> your-page.html
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-[1.75] text-[#c9cbe3]">
              <span className="text-[#6b6f8e]">{'<!-- Where the ad should appear -->'}</span>{'\n'}
              <span className="text-[#ff8a66]">{'<div'}</span> <span className="text-[#8b85ff]">id</span>=<span className="text-[#4fd1a5]">&quot;bn-ad-slot-sidebar&quot;</span> <span className="text-[#8b85ff]">data-bn-slot</span>=<span className="text-[#4fd1a5]">&quot;sidebar&quot;</span><span className="text-[#ff8a66]">{'></div>'}</span>{'\n\n'}
              <span className="text-[#6b6f8e]">{'<!-- Once per page -->'}</span>{'\n'}
              <span className="text-[#ff8a66]">{'<script'}</span> <span className="text-[#8b85ff]">async</span>{'\n  '}
              <span className="text-[#8b85ff]">src</span>=<span className="text-[#4fd1a5]">&quot;https://&lt;your-ad-server&gt;/sdk/ads.js&quot;</span>{'\n  '}
              <span className="text-[#8b85ff]">data-site-key</span>=<span className="text-[#4fd1a5]">&quot;pk_…&quot;</span><span className="text-[#ff8a66]">{'></script>'}</span>
            </pre>
          </div>
        </Container>
      </section>

      {/* Closing CTA */}
      <section className="px-4 pb-24 sm:px-6">
        <div className="scheme-dark relative mx-auto max-w-7xl overflow-hidden rounded-[28px] bg-bg px-6 py-20 text-center text-fg sm:px-12">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(45%_70%_at_20%_110%,color-mix(in_srgb,var(--primary)_45%,transparent),transparent),radial-gradient(40%_60%_at_85%_105%,color-mix(in_srgb,var(--accent)_35%,transparent),transparent),radial-gradient(30%_50%_at_55%_0%,color-mix(in_srgb,var(--info)_22%,transparent),transparent)]" aria-hidden />
          <div className="relative">
            <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-[-0.02em] sm:text-5xl">Start growing with {brand.shortName} today</h2>
            <p className="mx-auto mt-4 max-w-xl text-lg text-muted">Create an account in a couple of minutes. Advertisers can draft campaigns right away; publishers can add and verify a site the same day.</p>
            <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
              <Link href="/register?type=advertiser" className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-white px-6 text-[15px] font-semibold text-[#12142b] hover:bg-white/90">Start advertising <ArrowRight className="size-4" aria-hidden /></Link>
              <Link href="/register?type=publisher" className="inline-flex h-12 items-center justify-center rounded-lg border border-white/25 px-6 text-[15px] font-semibold text-white hover:bg-white/10">Monetize your website</Link>
            </div>
            <p className="mt-8 text-xs text-muted">{brand.productName} by {brand.companyName}</p>
          </div>
        </div>
      </section>
    </>
  );
}
