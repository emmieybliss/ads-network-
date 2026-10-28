/**
 * Demo publisher website for local testing.
 *
 * Serves one fictional article page with BlissNova placements, using the
 * same snippet a real publisher pastes, and /consent-test, which shows how
 * the tag reacts to consent signals from a stand-in consent tool, and /pop-test, which
 * shows a pop-under placement. It has no dependencies and must not
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

const slot = (key, extra = '', div = '') => `<div id="bn-ad-slot-${key}" data-bn-slot="${key}"${div}></div>
<script async src="${esc(apiUrl)}/sdk/ads.js" data-site-key="${esc(siteKey)}" data-slot="${key}"${extra}></script>`;

const ARTICLES = {
  1: { title: 'Five small habits for a calmer workday', path: '/calmer-workday', next: 2 },
  2: { title: 'A beginner\'s guide to keeping houseplants alive', path: '/houseplants-guide', next: 1 },
};
// Each article has its own path so per-page reports can tell them apart.
const ARTICLE_BY_PATH = { '/': 1, '/index.html': 1, [ARTICLES[1].path]: 1, [ARTICLES[2].path]: 2 };

// Generic sample text for the long demo article; fictional and for layout only.
const LONG = [
  'Most houseplants that struggle indoors are not short of care. They are usually short of light, or they are getting too much water. Start by checking where the plant came from: a shade-loving fern and a sun-loving succulent need very different spots.',
  'A simple test for light is your own shadow. Hold your hand above the place you want to put the plant at midday. A crisp shadow means bright light, a soft shadow means medium light, and no clear shadow means low light.',
  'Water when the top few centimetres of soil are dry, not on a fixed day of the week. Push a finger into the pot. If it comes out clean and dry, water slowly until a little runs out of the drainage hole, then empty the saucer.',
  'Pots without drainage holes are the most common cause of trouble. Water collects at the bottom, the roots sit in it, and they start to rot long before the leaves show it. If you love a decorative pot, keep the plant in a plastic nursery pot inside it.',
  'Yellow lower leaves often mean too much water; crisp brown edges often mean too little water or very dry air. Change one thing at a time and wait two weeks before deciding whether it helped.',
  'Feed during spring and summer only, at half the strength the label suggests. Plants grow slowly in winter and do not need the extra nutrients; feeding then mostly builds up salts in the soil.',
  'Repot when roots circle the bottom of the pot or push out of the drainage hole, usually every one to two years. Choose a pot only a few centimetres wider. A much larger pot holds water the roots cannot reach.',
  'Wipe dusty leaves with a damp cloth now and then. Dust blocks light, and clean leaves also make it easier to spot pests early, such as the fine webbing of spider mites under the leaves.',
  'If a plant arrives looking sad, give it a few weeks before changing everything. Moving from a greenhouse to a living room is a big change, and most plants drop a leaf or two while they adjust.',
  'Finally, keep a short note of when you water and feed each plant. After a month you will see a pattern, and caring for them becomes a quick weekly habit rather than guesswork.',
];

const page = (n = 1) => `<!doctype html>
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
${slot('demo-leaderboard', '', ' style="min-height:min(90px, 12.36vw)"')}
</div>
<div class="wrap">
  <article>
    <h2>${esc(ARTICLES[n].title)}</h2>
    <div class="byline">By the Demo Gazette desk · sample article</div>
${n === 1 ? `
    <p>This page exists so you can watch the BlissNova ad tag work end to end. Above, a leaderboard placement requests an image ad. In the sidebar, a text placement requests a text ad. Below this paragraph, an in-article placement requests a native ad, which matches the page's layout but is always marked "Sponsored" with the advertiser's name. All three use the same short snippet any publisher can paste into a page.</p>
    ${slot('demo-native')}
    <p>When an ad renders, the tag reports a render receipt. When at least half of the ad stays visible for a second, it reports a viewable impression. Clicking the ad goes through the network's click endpoint, which records a click before sending you on to the advertiser.</p>
    <p>Open the publisher or advertiser dashboard in another tab and refresh it after viewing and clicking: today's numbers update from the recorded events. Repeated views from the same browser are limited by frequency caps, and very fast or repeated clicks are filtered as invalid, exactly as on a live site.</p>
    <p>The tag does not read cookies or store identifiers unless the page signals consent for personalized ads. This demo page does not, so all ads here are contextual. The <a href="/consent-test">consent test page</a> shows what happens with a consent tool.</p>
` : `
    <p>This second sample article shows <strong>automatic in-article ads</strong>. The page has no in-article ad snippet: its tag script carries <code>data-auto="1"</code>, and the tag adds ads between paragraphs using the site's settings (first after paragraph 2, then every 3 paragraphs, at most 3).</p>
${LONG.map((t) => `    <p>${esc(t)}</p>`).join('\n')}
    ${n === 2 ? `<script async src="${esc(apiUrl)}/sdk/ads.js" data-site-key="${esc(siteKey)}" data-auto="1"></script>` : ''}
`}
    <p>Other placement types: a <strong>sticky anchor</strong> at the bottom of the screen (close it with ×), a <strong>side rail</strong> on the right on wide screens, and an <strong>interstitial</strong> that appears when you follow the link below to the next article. The interstitial shows at most once every 10 minutes in a tab.</p>
    <p>Pop-ups and pop-unders are on their own page, so they do not get in the way here: <a href="/pop-test">see the pop-under demo</a>.</p>
    <p><a href="${ARTICLES[ARTICLES[n].next].path}" id="next-article">Read the next article: ${esc(ARTICLES[ARTICLES[n].next].title)}</a></p>
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
${slot('demo-anchor', '', ' data-bn-display="anchor"')}
${slot('demo-rail', '', ' data-bn-display="rail_right"')}
${slot('demo-interstitial', '', ' data-bn-display="interstitial"')}
</body>
</html>`;


/* ------------------------------------------------------------------------
 * /consent-test: a stand-in consent tool (CMP) for checking the tag. It is
 * NOT a real CMP and collects no choices; it just answers the IAB APIs with
 * fixed test signals so you can see what the tag and the server do.
 * --------------------------------------------------------------------- */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const b64 = (bits) => { const p = bits.padEnd(Math.ceil(bits.length / 6) * 6, '0'); let o = ''; for (let i = 0; i < p.length; i += 6) o += B64[parseInt(p.slice(i, i + 6), 2)]; return o; };
const int = (v, n) => v.toString(2).padStart(n, '0');
/** TCF v2.2 core string; `all` consents to purposes 1-10 and every vendor. */
function testTcString(all) {
  const t = int(Math.floor(Date.now() / 100), 36);
  // version, created, updated, CMP id, CMP version, screen, language EN, vendor list, policy 4 (v2.2), service-specific, std texts, special features
  let b = int(2, 6) + t + t + int(0, 12) + int(1, 12) + int(1, 6) + int(4 * 64 + 13, 12) + int(1, 12) + int(4, 6) + '1' + '0' + int(0, 12);
  b += (all ? '1'.repeat(10) : '0'.repeat(10)) + '0'.repeat(14) + int(0, 24) + '0' + int(4 * 64 + 13, 12);
  b += all ? int(65535, 16) + '1' + int(1, 12) + '1' + int(1, 16) + int(65535, 16) : int(0, 16) + '0';
  return b64(b + int(0, 16) + '0' + int(0, 12));
}
const fib = (n) => { const q = [1, 2]; while (q[q.length - 1] <= n) q.push(q[q.length - 1] + q[q.length - 2]); const bits = q.map(() => '0'); let r = n; for (let i = q.length - 1; i >= 0; i--) if (q[i] <= r) { bits[i] = '1'; r -= q[i]; } return bits.join('').replace(/0+$/, '') + '1'; };
/** GPP string with one usnat section; optedOut sets sale, sharing and targeted-ads opt-outs. */
const testGpp = (optedOut) => `${b64(int(3, 6) + int(1, 6) + int(1, 12) + '0' + fib(7))}~${b64(int(1, 6) + '01'.repeat(6) + (optedOut ? '01' : '10').repeat(3) + '0'.repeat(40))}`;

const SCENARIOS = {
  none: { label: 'No consent tool', note: 'No CMP on the page. The tag requests contextual ads straight away.' },
  'eu-accept': { label: 'EU visitor accepts all', note: 'A TCF v2.2 CMP reports GDPR applies and consent to all purposes and vendors.' },
  'eu-reject': { label: 'EU visitor rejects all', note: 'A TCF v2.2 CMP reports GDPR applies and no consent.' },
  'us-ok': { label: 'US visitor, no opt-out', note: 'A GPP CMP sends a US national section with no opt-outs, and the site opts in with data-consent="personalized".' },
  'us-optout': { label: 'US visitor opted out', note: 'A GPP CMP sends a US national section with opt-outs of sale, sharing and targeted ads.' },
};

function cmpScript(kind) {
  if (kind === 'eu-accept' || kind === 'eu-reject') {
    const tc = testTcString(kind === 'eu-accept');
    return `window.__tcfapi = function (cmd, v, cb) {
  var d = { tcString: ${JSON.stringify(tc)}, gdprApplies: true, eventStatus: 'tcloaded', cmpStatus: 'loaded', listenerId: 1,
    purpose: { consents: ${kind === 'eu-accept' ? '{1:true,2:true,3:true,4:true,7:true}' : '{}'} }, vendor: { consents: {} } };
  if (cmd === 'addEventListener' || cmd === 'getTCData') setTimeout(function () { cb(d, true); }, 300);
  else if (cmd === 'ping') cb({ gdprApplies: true, cmpLoaded: true }, true);
};`;
  }
  if (kind === 'us-ok' || kind === 'us-optout') {
    const g = testGpp(kind === 'us-optout');
    return `window.__gpp = function (cmd, cb) {
  var ping = { gppVersion: '1.1', cmpStatus: 'loaded', signalStatus: 'ready', gppString: ${JSON.stringify(g)}, applicableSections: [7], supportedAPIs: ['7:usnat'] };
  if (cmd === 'ping') setTimeout(function () { cb(ping, true); }, 300);
  else if (cmd === 'addEventListener') setTimeout(function () { cb({ eventName: 'signalStatus', data: 'ready', pingData: ping, listenerId: 1 }, true); }, 300);
};
`;
  }
  return '';
}

const REASONS = {
  pending: 'Waiting for the first ad request.',
  allowed: 'Personalized ads allowed. The tag may keep a visitor id.',
  network_off: 'Contextual: personalized ads are switched off for the whole network (Admin, Settings, tracking "Personalized allowed").',
  no_consent: 'Contextual: the site has not opted in to personalized ads.',
  gpc: 'Contextual: the browser sends Global Privacy Control.',
  usp_opt_out: 'Contextual: the US Privacy string says the visitor opted out of sale.',
  gpp_opt_out: 'Contextual: the GPP string says the visitor opted out.',
  gpp_unsupported: 'Contextual: the GPP string has a section the network cannot read yet, so it is treated as an opt-out.',
  gpp_invalid: 'Contextual: the GPP string could not be read.',
  tcf_missing: 'Contextual: GDPR applies but there is no TC string.',
  tcf_invalid: 'Contextual: the TC string could not be read.',
  tcf_no_vendor_id: 'Contextual: GDPR applies and the network has no IAB vendor id configured (TCF_VENDOR_ID), so it never claims TCF consent.',
  tcf_denied: 'Contextual: the visitor did not consent to the purposes or vendor needed.',
};

const consentPage = (kind) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Consent test (local demo publisher)</title>
<style>
  :root { color-scheme: light dark; --bg: #fbfaf7; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --accent: #b45309; --card: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --accent: #f59e0b; --card: #292524; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, sans-serif; }
  .banner { background: #fef3c7; color: #78350f; font-size: 13px; padding: 8px 16px; text-align: center; }
  main { max-width: 760px; margin: 24px auto; padding: 0 16px; }
  h1 { font: 600 26px/1.2 Georgia, serif; margin: 0 0 6px; }
  .muted { color: var(--muted); }
  nav { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0; }
  nav a { border: 1px solid var(--line); border-radius: 999px; padding: 5px 12px; color: var(--fg); text-decoration: none; font-size: 14px; }
  nav a[aria-current] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 16px 0; }
  .card strong { display: block; font-size: 16px; }
  pre { white-space: pre-wrap; word-break: break-all; font-size: 12px; color: var(--muted); margin: 8px 0 0; }
  a { color: var(--accent); }
</style>
${kind !== 'none' ? `<script>\n${cmpScript(kind)}\n</script>` : ''}
</head>
<body>
<div class="banner">Local demo only. This page uses a stand-in consent tool with fixed test signals. It is not a real CMP and records no choices.</div>
<main>
  <h1>Consent test</h1>
  <p class="muted">Pick a scenario. The page loads the normal BlissNova tag, which reads the consent signals and sends them with the ad request. The server decides whether the ad may be personalized.</p>
  <nav>${Object.entries(SCENARIOS).map(([k, v]) => `<a href="/consent-test?cmp=${k}"${k === kind ? ' aria-current="page"' : ''}>${esc(v.label)}</a>`).join('')}</nav>
  <div class="card"><strong>${esc(SCENARIOS[kind].label)}</strong><span class="muted">${esc(SCENARIOS[kind].note)}</span></div>
  <div class="card result" id="result"><strong>Result</strong><span id="reason" class="muted">Waiting for the first ad request...</span><pre id="raw"></pre></div>
  ${slot('demo-native', kind === 'us-ok' ? ' data-consent="personalized"' : '')}
  <p class="muted"><a href="/">Back to the demo article</a></p>
</main>
<script>
  var REASONS = ${JSON.stringify(REASONS)};
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var bn = window.blissnova;
    if (!bn || !bn.getPrivacy) { if (tries > 40) clearInterval(timer); return; }
    var p = bn.getPrivacy();
    if (p.reason === 'pending' && tries < 40) return;
    clearInterval(timer);
    document.getElementById('reason').textContent = REASONS[p.reason] || p.reason;
    document.getElementById('raw').textContent = 'window.blissnova.getPrivacy() = ' + JSON.stringify(p, null, 2);
  }, 250);
</script>
</body>
</html>`;

const popPage = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pop-under test (local demo publisher)</title>
<style>
  :root { color-scheme: light dark; --bg: #fbfaf7; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --accent: #b45309; --card: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --accent: #f59e0b; --card: #292524; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, sans-serif; }
  .banner { background: #fef3c7; color: #78350f; font-size: 13px; padding: 8px 16px; text-align: center; }
  main { max-width: 760px; margin: 24px auto; padding: 0 16px; }
  h1 { font: 600 26px/1.2 Georgia, serif; margin: 0 0 6px; }
  .muted { color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 16px 0; }
  .card ul { margin: 6px 0 0; padding-left: 20px; }
  button { font: 600 15px system-ui, sans-serif; padding: 10px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--fg); color: var(--bg); cursor: pointer; }
  a { color: var(--accent); }
</style>
</head>
<body>
<div class="banner">Local demo publisher website. Fictional content for testing ad delivery. Not a real publication.</div>
<main>
  <h1>Pop-under test</h1>
  <p class="muted">This page has a pop-under placement. Nothing opens when the page loads. Click anywhere on the page (the button is just a convenient target) and the demo advertiser's landing page opens in a new tab, once.</p>
  <p><button type="button" id="pop-target">Click anywhere, for example here</button></p>
  <div class="card">
    <strong>What to expect</strong>
    <ul>
      <li>At most one pop per page view, and only from a real click. Clicks on ads and form fields never open one.</li>
      <li>The demo placement allows 3 pops per visitor per day, at least 15 minutes apart. Reload within 15 minutes and nothing opens.</li>
      <li>Most current browsers keep the new tab in front, so a pop-under often looks like a pop-up.</li>
      <li>If your browser blocks the new tab, nothing is counted. Only pops that actually opened show up in the reports.</li>
      <li>An admin can turn pops off for the whole network in Settings, then this page opens nothing.</li>
    </ul>
  </div>
  <p class="muted"><a href="/">Back to the demo article</a></p>
</main>
${slot('demo-popunder', '', ' data-bn-display="popunder"')}
</body>
</html>`;

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    return;
  }
  const consentKind = url.pathname === '/consent-test' ? (Object.hasOwn(SCENARIOS, url.searchParams.get('cmp') ?? '') ? url.searchParams.get('cmp') : 'none') : null;
  if (url.searchParams.get('article') === '2') {
    res.writeHead(301, { location: ARTICLES[2].path }).end();
    return;
  }
  const article = ARTICLE_BY_PATH[url.pathname];
  const pop = url.pathname === '/pop-test';
  if (!article && !consentKind && !pop) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  }).end(pop ? popPage() : consentKind ? consentPage(consentKind) : page(article));
}).listen(port, () => console.log(`Demo publisher site on http://localhost:${port} (also http://demo-publisher.localhost:${port})`));
