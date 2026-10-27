/**
 * Demo publisher website for local testing.
 *
 * Serves one fictional article page with two BlissNova placements, using the
 * same snippet a real publisher pastes. It has no dependencies and must not
 * be deployed publicly: it exists only to show ad delivery end to end on
 * your own machine.
 *
 *   DEMO_SITE_PORT   port to listen on (default 3100)
 *   DEMO_API_URL     where the browser reaches the API (default http://localhost:4000)
 *   DEMO_SITE_KEY    the demo site's public key (matches the demo seed)
 */
import { createServer } from 'node:http';

const port = Number(process.env.DEMO_SITE_PORT ?? 3100);
const apiUrl = (process.env.DEMO_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const siteKey = process.env.DEMO_SITE_KEY ?? 'pk_DemoLocalPublisherSite01';
const webUrl = (process.env.DEMO_WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '');

if (process.env.NODE_ENV === 'production') {
  console.error('The demo publisher site is for local development only and does not run with NODE_ENV=production.');
  process.exit(1);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const slot = (key) => `<div id="bn-ad-slot-${key}" data-bn-slot="${key}"></div>
<script async src="${esc(apiUrl)}/sdk/ads.js" data-site-key="${esc(siteKey)}" data-slot="${key}"></script>`;

const page = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Demo Gazette (local demo publisher)</title>
<style>
  :root { color-scheme: light dark; --bg: #fbfaf7; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --accent: #b45309; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --accent: #f59e0b; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.65 Georgia, 'Times New Roman', serif; }
  .banner { background: #fef3c7; color: #78350f; font: 13px/1.4 system-ui, sans-serif; padding: 8px 16px; text-align: center; }
  header { border-bottom: 1px solid var(--line); padding: 18px 16px; text-align: center; }
  header h1 { margin: 0; font-size: 34px; letter-spacing: -0.5px; }
  header p { margin: 4px 0 0; color: var(--muted); font: 13px system-ui, sans-serif; }
  .top-ad { max-width: 760px; margin: 18px auto 0; padding: 0 16px; }
  .wrap { max-width: 1040px; margin: 24px auto; padding: 0 16px; display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 40px; }
  article h2 { font-size: 30px; line-height: 1.2; margin: 0 0 6px; }
  .byline { color: var(--muted); font: 13px system-ui, sans-serif; margin-bottom: 18px; }
  aside { font: 15px/1.5 system-ui, sans-serif; }
  aside h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
  footer { border-top: 1px solid var(--line); color: var(--muted); font: 13px system-ui, sans-serif; text-align: center; padding: 24px 16px; }
  a { color: var(--accent); }
  @media (max-width: 820px) { .wrap { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="banner">Local demo publisher website. Fictional content for testing ad delivery. Not a real publication.</div>
<header><h1>The Demo Gazette</h1><p>A sample site that runs on your computer</p></header>
<div class="top-ad">
${slot('demo-leaderboard')}
</div>
<div class="wrap">
  <article>
    <h2>Five small habits for a calmer workday</h2>
    <div class="byline">By the Demo Gazette desk · sample article</div>
    <p>This page exists so you can watch the BlissNova ad tag work end to end. Above, a leaderboard placement requests an image ad. In the sidebar, a text placement requests a text ad. Below this paragraph, an in-article placement requests a native ad, which matches the page's layout but is always marked "Sponsored" with the advertiser's name. All three use the same short snippet any publisher can paste into a page.</p>
    ${slot('demo-native')}
    <p>When an ad renders, the tag reports a render receipt. When at least half of the ad stays visible for a second, it reports a viewable impression. Clicking the ad goes through the network's click endpoint, which records a click before sending you on to the advertiser.</p>
    <p>Open the publisher or advertiser dashboard in another tab and refresh it after viewing and clicking: today's numbers update from the recorded events. Repeated views from the same browser are limited by frequency caps, and very fast or repeated clicks are filtered as invalid, exactly as on a live site.</p>
    <p>The tag does not read cookies or store identifiers unless the page signals consent for personalized ads. This demo page does not, so all ads here are contextual.</p>
    <p><a href="${esc(webUrl)}/publisher">Open the publisher dashboard</a> · <a href="${esc(webUrl)}/advertiser">Open the advertiser dashboard</a></p>
  </article>
  <aside>
    <h3>Sponsored</h3>
    ${slot('demo-sidebar')}
    <h3>About this demo</h3>
    <p>The site is registered as <code>demo-publisher.localhost</code>, a reserved name that can only exist on your own machine. It was verified with the development simulator, which the platform refuses to use in production.</p>
  </aside>
</div>
<footer>The Demo Gazette is fictional. Ads shown here are demo creatives.</footer>
</body>
</html>`;

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    return;
  }
  if (url.pathname !== '/' && url.pathname !== '/index.html') {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  }).end(page());
}).listen(port, () => console.log(`Demo publisher site on http://localhost:${port} (also http://demo-publisher.localhost:${port})`));
