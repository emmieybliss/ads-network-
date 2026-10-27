import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Documentation', description: 'Publisher integration, advertiser setup, measurement definitions and the BlissNova REST API.' };

function Code({ children }: { children: string }) {
  return <pre className="mt-3 overflow-x-auto rounded-xl border border-border bg-surface-2 p-4 font-mono text-[12.5px] leading-relaxed text-fg-2">{children}</pre>;
}

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return <h2 id={id} className="mt-16 scroll-mt-24 border-t border-border pt-10 text-2xl font-semibold tracking-tight first:mt-0 first:border-0 first:pt-0">{children}</h2>;
}

export default function DocsPage() {
  return (
    <div className="mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[220px_1fr]">
      <nav className="hidden lg:block" aria-label="Documentation">
        <div className="sticky top-24 space-y-1 text-sm">
          {[['publishers', 'Publisher integration'], ['multiple', 'Multiple placements'], ['consent', 'Consent and privacy'], ['limitations', 'Browser limitations'], ['verification', 'Domain verification'], ['advertisers', 'Advertiser guide'], ['creatives', 'Creative specifications'], ['measurement', 'Measurement'], ['api', 'REST API'], ['resources', 'Resources']].map(([id, l]) => (
            <a key={id} href={`#${id}`} className="block rounded-md px-2 py-1.5 text-muted hover:bg-surface-2 hover:text-fg">{l}</a>
          ))}
        </div>
      </nav>
      <article className="min-w-0 max-w-3xl text-[15px] leading-relaxed text-fg-2">
        <h1 className="text-4xl font-semibold tracking-tight text-fg">Documentation</h1>
        <p className="mt-3 text-lg text-muted">Everything you need to place ads on a site, run a campaign, or build against the API.</p>

        <H2 id="publishers">Publisher integration</H2>
        <p className="mt-3">Once your site is approved, open <strong>Websites → your site → Ad tag</strong> in the publisher portal. Each placement has a self-contained snippet. Paste it into your page’s HTML where the ad should appear:</p>
        <Code>{`<div id="bn-ad-slot-sidebar_300x250" data-bn-slot="sidebar_300x250"></div>
<script async src="https://<your-ad-server>/sdk/ads.js"
        data-site-key="pk_your_public_site_key"
        data-slot="sidebar_300x250"></script>`}</Code>
        <p className="mt-3">The address, site key and placement names in your portal are generated for your account. The site key is public by design: it identifies your site and only works on the hostnames you verified. Never put an API key (<code>bnk_…</code>) in a page.</p>
        <p className="mt-3">Any website or content-management system that lets you add HTML can use the tag. No plugin is needed.</p>

        <H2 id="multiple">Multiple placements on one page</H2>
        <p className="mt-3">Load the script once and add one container per placement. Containers added later (for example by infinite scroll) are picked up automatically.</p>
        <Code>{`<script async src="https://<your-ad-server>/sdk/ads.js" data-site-key="pk_…"></script>
<div data-bn-slot="header_728x90"></div>
<div data-bn-slot="in_article"></div>`}</Code>

        <H2 id="consent">Consent and privacy</H2>
        <p className="mt-3">By default the tag requests contextual, non-personalized ads and stores nothing on the visitor’s device. If your consent tool records consent for personalized advertising, tell the tag:</p>
        <Code>{`window.blissnova && window.blissnova.setConsent({ personalized: true });
// and when consent is withdrawn:
window.blissnova && window.blissnova.setConsent({ personalized: false });`}</Code>
        <p className="mt-3">Withdrawing consent deletes the tag’s pseudonymous identifier. You can also set <code>data-consent="non-personalized"</code> on the script tag.</p>

        <H2 id="limitations">Browser limitations</H2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5">
          <li><strong>Ad blockers</strong> may block the tag entirely. We do not try to circumvent them, and blocked requests are simply not counted.</li>
          <li><strong>JavaScript disabled:</strong> no ad is requested and nothing is counted.</li>
          <li><strong>Privacy settings</strong> (for example blocked storage) mean the visitor is treated as non-personalized.</li>
          <li><strong>Network failures:</strong> event reports are batched and retried a bounded number of times; events that never arrive are never billed.</li>
          <li><strong>Viewability</strong> needs IntersectionObserver; older browsers report renders but not viewability.</li>
        </ul>

        <H2 id="verification">Domain verification</H2>
        <p className="mt-3">Choose one method in <strong>Websites → your site → Verification</strong>. Each challenge has its own token and expires; start a new one if it does.</p>
        <ul className="mt-3 list-disc space-y-1.5 pl-5">
          <li><strong>DNS TXT:</strong> a TXT record at <code>_blissnova-verification.&lt;your-domain&gt;</code>. DNS proofs also cover your subdomains.</li>
          <li><strong>File:</strong> a plain-text file at <code>/.well-known/blissnova-verification.txt</code> containing only the token. Redirects to other hosts are not followed.</li>
          <li><strong>Meta tag:</strong> <code>&lt;meta name="blissnova-site-verification" content="…"&gt;</code> inside your homepage’s <code>&lt;head&gt;</code>.</li>
        </ul>
        <p className="mt-3">Verification checks run from our servers over HTTPS, only to your public hostname, with strict timeouts. After verification, submit the site for review.</p>

        <H2 id="advertisers">Advertiser guide</H2>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5">
          <li>Fund your account under <strong>Billing</strong>.</li>
          <li>Create a campaign: objective, dates, budget, daily limit, pricing model, targeting and frequency caps.</li>
          <li>Add at least one creative, then submit the campaign for review.</li>
          <li>Approved campaigns start on their start date. Pause, resume or edit them at any time; some edits send the campaign back for review.</li>
        </ol>

        <H2 id="creatives">Creative specifications</H2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5">
          <li>Image banners: PNG, JPEG, GIF or WebP, within the size limit shown in the upload form. Common sizes: 300×250, 728×90, 320×50, 160×600, 300×600.</li>
          <li>Text ads: headline, description, call to action and display URL.</li>
          <li>Destination URLs must be HTTPS and must work. Redirect chains and cloaking are not allowed.</li>
          <li>No scripts, no auto-playing audio, no imitation of system dialogs or site content.</li>
        </ul>

        <H2 id="measurement">Measurement</H2>
        <dl className="mt-3 space-y-3">
          {[
            ['Ad request', 'A call from the tag asking for ads for one or more placements.'],
            ['Served', 'An ad returned by the ad server. Not an impression and never billed.'],
            ['Rendered impression', 'The tag inserted the creative and reported it with a valid, unexpired delivery token.'],
            ['Viewable impression', '≥50% of the creative in view for ≥1 continuous second.'],
            ['Valid click', 'A click through the tracking redirect that passed invalid-traffic checks; at most one per impression.'],
            ['Invalid event', 'An event rejected by invalid-traffic checks. Shown in reports, never billed.'],
            ['Billable event', 'A valid render (CPM) or valid click (CPC) charged within budget.'],
            ['CTR', 'Valid clicks ÷ valid impressions × 100, from totals.'],
            ['eCPM / RPM', 'Spend (or publisher earnings) ÷ valid impressions × 1,000.'],
          ].map(([k, v]) => (<div key={k}><dt className="font-medium text-fg">{k}</dt><dd className="text-muted">{v}</dd></div>))}
        </dl>

        <H2 id="api">REST API</H2>
        <p className="mt-3">The API is versioned under <code>/api/v1</code> and described with OpenAPI. Browse it at <Link href="/docs/api" className="text-primary hover:underline">/docs/api</Link>. Server-to-server integrations authenticate with an organization API key in the <code>Authorization: Bearer</code> header. Keep that key on your server.</p>
        <Code>{`curl -H "Authorization: Bearer $BLISSNOVA_API_KEY" \\
  "https://<your-ad-server>/api/v1/integrations/ping"`}</Code>

        <H2 id="resources">Resources</H2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5">
          <li><Link className="text-primary hover:underline" href="/publisher-requirements">Publisher requirements</Link></li>
          <li><Link className="text-primary hover:underline" href="/policies/advertisers">Advertiser policies</Link> and <Link className="text-primary hover:underline" href="/policies/publishers">publisher policies</Link></li>
          <li><Link className="text-primary hover:underline" href="/report-abuse">Report an ad or a site</Link></li>
        </ul>
      </article>
    </div>
  );
}
