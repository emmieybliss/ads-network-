/**
 * BlissNova ad tag.
 *
 * Loaded by publishers as:
 *   <script async src="https://<api-host>/sdk/v1/bn.js"
 *           data-site-key="pk_..." data-api="https://<api-host>"></script>
 *   <div class="blissnova-ad" data-bn-slot="sidebar_300x250"></div>
 *
 * Design notes:
 * - No framework, no dependencies, no cookies written by this script.
 * - Creative content is inserted with textContent / explicit element
 *   properties only. Nothing from the API is ever passed to innerHTML.
 * - Each slot renders inside a closed shadow root so publisher CSS cannot
 *   restyle (or hide) the required "Sponsored" label.
 * - A visitor id is stored in localStorage only while consent allows
 *   personalisation; revoking consent deletes it.
 * - Any failure collapses the slot quietly. We never block page rendering and
 *   we never retry in a loop.
 */

type Format = 'image' | 'text';

interface AdPayload {
  format: Format;
  token: string;
  clickUrl: string;
  width: number | null;
  height: number | null;
  image?: { url: string; alt: string };
  text?: { headline: string; body: string; cta: string; displayUrl: string };
}
interface ServeResponse {
  status: 'ok' | 'inactive' | 'blocked' | 'disabled';
  ads: Array<{ slot: string; ad: AdPayload | null }>;
}
interface Consent {
  personalized: boolean;
  gdprApplies?: boolean;
}

const VID_KEY = 'bn_vid';
const SLOT_SELECTOR = '.blissnova-ad[data-bn-slot]';
const VIEWABLE_RATIO = 0.5;
const VIEWABLE_MS = 1000;
const BATCH_MS = 1500;
const MAX_BATCH = 20;

/* ------------------------------------------------------------------ utils */

const idChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function randomId(len: number): string {
  const bytes = new Uint8Array(len);
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (let i = 0; i < len; i++) out += idChars[(bytes[i] as number) % idChars.length];
  return out;
}

function store(): Storage | null {
  try {
    const s = window.localStorage;
    const probe = '__bn';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function readVid(consent: Consent): string | undefined {
  if (!consent.personalized) return undefined;
  const s = store();
  if (!s) return undefined;
  try {
    let v = s.getItem(VID_KEY);
    if (!v || !/^[A-Za-z0-9_-]{16,64}$/.test(v)) {
      v = randomId(22);
      s.setItem(VID_KEY, v);
    }
    return v;
  } catch {
    return undefined;
  }
}

function dropVid(): void {
  const s = store();
  try {
    s?.removeItem(VID_KEY);
  } catch {
    /* nothing to do */
  }
}

/** The page URL without query or fragment: enough for contextual targeting,
 *  and it avoids forwarding whatever a publisher keeps in query strings. */
function pageUrl(): string {
  try {
    const u = new URL(window.location.href);
    return `${u.origin}${u.pathname}`.slice(0, 2048);
  } catch {
    return String(window.location.href).slice(0, 2048);
  }
}

function keywords(): string[] | undefined {
  const out: string[] = [];
  const push = (raw: string | null | undefined) => {
    if (!raw) return;
    for (const part of raw.split(',')) {
      const k = part.trim().slice(0, 60);
      if (k && out.indexOf(k) === -1 && out.length < 20) out.push(k);
    }
  };
  try {
    push(document.querySelector('meta[name="keywords"]')?.getAttribute('content'));
    push(document.querySelector('meta[property="article:tag"]')?.getAttribute('content'));
  } catch {
    /* ignore malformed documents */
  }
  return out.length ? out : undefined;
}

/* ------------------------------------------------------------- the runtime */

class Tag {
  private readonly api: string;
  private readonly siteKey: string;
  private readonly pv = randomId(16);
  private consent: Consent = { personalized: false };
  private consentSet = false;
  private readonly queue: Array<{ id: string; type: 'render' | 'viewable'; t: string }> = [];
  private flushTimer: number | null = null;
  private readonly seen = new WeakSet<Element>();
  private pending: Element[] = [];
  private lazy: IntersectionObserver | null = null;
  private started = false;

  constructor(api: string, siteKey: string) {
    this.api = api.replace(/\/+$/, '');
    this.siteKey = siteKey;
  }

  /** Publisher API: window.blissnova.setConsent({ personalized: true }). */
  setConsent(c: Partial<Consent> | boolean): void {
    const next: Consent = typeof c === 'boolean' ? { personalized: c } : { personalized: !!c.personalized, gdprApplies: c.gdprApplies };
    const was = this.consent.personalized;
    this.consent = next;
    this.consentSet = true;
    if (was && !next.personalized) dropVid();
    if (this.started) this.scan();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scan();
    // Slots added later (infinite scroll, client-side routing) are picked up.
    try {
      new MutationObserver(() => this.scan()).observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      /* MutationObserver missing: static pages still work */
    }
    window.addEventListener('pagehide', () => this.flush(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush(true);
    });
  }

  /** Publisher API: window.blissnova.refresh() after injecting new slots. */
  refresh(): void {
    this.scan();
  }

  private scan(): void {
    let nodes: Element[];
    try {
      nodes = Array.prototype.slice.call(document.querySelectorAll(SLOT_SELECTOR)) as Element[];
    } catch {
      return;
    }
    for (const el of nodes) {
      if (this.seen.has(el)) continue;
      this.seen.add(el);
      if (el.getAttribute('data-bn-lazy') === 'false' || !('IntersectionObserver' in window)) {
        this.enqueue(el);
        continue;
      }
      this.lazy ??= new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            this.lazy?.unobserve(e.target);
            this.enqueue(e.target);
          }
        },
        { rootMargin: '200px 0px' },
      );
      this.lazy.observe(el);
    }
  }

  /** Collect slots that became eligible in the same tick into one request. */
  private enqueue(el: Element): void {
    this.pending.push(el);
    if (this.pending.length === 1) setTimeout(() => void this.request(), 0);
  }

  private async request(): Promise<void> {
    const batch = this.pending.splice(0, 10);
    if (this.pending.length) setTimeout(() => void this.request(), 0);
    if (!batch.length) return;
    const slots: string[] = [];
    const byslot = new Map<string, Element>();
    for (const el of batch) {
      const slot = el.getAttribute('data-bn-slot') ?? '';
      if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(slot)) {
        collapse(el);
        continue;
      }
      if (byslot.has(slot)) continue; // one request per slot name per call
      byslot.set(slot, el);
      slots.push(slot);
    }
    if (!slots.length) return;

    let res: ServeResponse;
    try {
      const r = await fetch(`${this.api}/api/v1/serve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        body: JSON.stringify({
          siteKey: this.siteKey,
          units: slots.map((slot) => ({ slot })),
          page: { url: pageUrl(), keywords: keywords() },
          consent: this.consentSet ? this.consent : undefined,
          vid: readVid(this.consent),
          pv: this.pv,
        }),
      });
      if (!r.ok) throw new Error(`serve ${r.status}`);
      res = (await r.json()) as ServeResponse;
    } catch {
      for (const el of byslot.values()) collapse(el);
      return;
    }

    for (const entry of res.ads ?? []) {
      const el = byslot.get(entry.slot);
      if (!el) continue;
      byslot.delete(entry.slot);
      if (!entry.ad) {
        collapse(el);
        continue;
      }
      try {
        this.render(el, entry.ad);
      } catch {
        collapse(el);
      }
    }
    for (const el of byslot.values()) collapse(el);
  }

  private render(el: Element, ad: AdPayload): void {
    const host = el as HTMLElement;
    host.textContent = '';
    host.style.display = '';
    const root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : null;
    const mount: Node & ParentNode = root ?? host;

    if (root) {
      const style = document.createElement('style');
      style.textContent = SHADOW_CSS;
      root.appendChild(style);
    }

    const frame = document.createElement('div');
    frame.className = 'bn-ad';
    if (ad.width) frame.style.maxWidth = `${ad.width}px`;

    const link = document.createElement('a');
    link.className = 'bn-link';
    link.href = ad.clickUrl;
    link.target = '_blank';
    link.rel = 'nofollow sponsored noopener noreferrer';

    if (ad.format === 'image' && ad.image) {
      const img = document.createElement('img');
      img.src = ad.image.url;
      img.alt = ad.image.alt;
      img.loading = 'lazy';
      img.decoding = 'async';
      if (ad.width) img.width = ad.width;
      if (ad.height) img.height = ad.height;
      img.addEventListener('error', () => collapse(host));
      link.appendChild(img);
    } else if (ad.format === 'text' && ad.text) {
      const box = document.createElement('div');
      box.className = 'bn-text';
      const h = document.createElement('div');
      h.className = 'bn-headline';
      h.textContent = ad.text.headline;
      const b = document.createElement('div');
      b.className = 'bn-body';
      b.textContent = ad.text.body;
      const meta = document.createElement('div');
      meta.className = 'bn-meta';
      const url = document.createElement('span');
      url.className = 'bn-url';
      url.textContent = ad.text.displayUrl;
      const cta = document.createElement('span');
      cta.className = 'bn-cta';
      cta.textContent = ad.text.cta;
      meta.appendChild(url);
      meta.appendChild(cta);
      box.appendChild(h);
      box.appendChild(b);
      box.appendChild(meta);
      link.appendChild(box);
    } else {
      collapse(host);
      return;
    }

    const label = document.createElement('span');
    label.className = 'bn-label';
    label.textContent = 'Sponsored';
    label.setAttribute('aria-hidden', 'false');

    frame.appendChild(link);
    frame.appendChild(label);
    mount.appendChild(frame);

    // A render is reported as soon as the creative is in the document.
    this.report('render', ad.token);
    this.watchViewability(host, ad.token);
  }

  /** IAB display standard: at least 50% of pixels in view for one second. */
  private watchViewability(el: Element, token: string): void {
    if (!('IntersectionObserver' in window)) return;
    let timer: number | null = null;
    const obs = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        if (!e) return;
        const visible = e.isIntersecting && e.intersectionRatio >= VIEWABLE_RATIO && document.visibilityState !== 'hidden';
        if (visible && timer === null) {
          timer = window.setTimeout(() => {
            obs.disconnect();
            this.report('viewable', token);
          }, VIEWABLE_MS);
        } else if (!visible && timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
      },
      { threshold: [0, VIEWABLE_RATIO, 1] },
    );
    obs.observe(el);
  }

  private report(type: 'render' | 'viewable', token: string): void {
    this.queue.push({ id: randomId(22), type, t: token });
    if (this.queue.length >= MAX_BATCH) {
      this.flush(false);
      return;
    }
    if (this.flushTimer === null) this.flushTimer = window.setTimeout(() => this.flush(false), BATCH_MS);
  }

  private flush(unloading: boolean): void {
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.queue.length) return;
    const events = this.queue.splice(0, this.queue.length);
    const url = `${this.api}/api/v1/events`;
    const body = JSON.stringify({ events });
    // sendBeacon survives unload; the API accepts text/plain for exactly this.
    if (navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return;
      } catch {
        /* fall through to fetch */
      }
    }
    try {
      void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, credentials: 'omit', keepalive: unloading, cache: 'no-store' }).catch(() => undefined);
    } catch {
      /* reporting is best effort; never surface an error to the page */
    }
  }
}

function collapse(el: Element): void {
  try {
    (el as HTMLElement).style.display = 'none';
    el.setAttribute('data-bn-state', 'empty');
  } catch {
    /* detached node */
  }
}

const SHADOW_CSS = `
:host{display:block}
.bn-ad{position:relative;font:400 14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2430;background:#fff;border:1px solid rgba(15,23,42,.1);border-radius:8px;overflow:hidden}
.bn-link{display:block;color:inherit;text-decoration:none}
.bn-link img{display:block;width:100%;height:auto;border:0}
.bn-text{padding:14px 14px 28px}
.bn-headline{font-weight:600;font-size:15px;margin-bottom:4px}
.bn-body{color:#4b5563;font-size:13px}
.bn-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px}
.bn-url{color:#6b7280;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bn-cta{flex:none;font-size:12px;font-weight:600;color:#1d4ed8}
.bn-label{position:absolute;right:0;bottom:0;padding:2px 6px;font:500 10px/1.3 system-ui,sans-serif;letter-spacing:.02em;color:#6b7280;background:rgba(255,255,255,.92);border-top-left-radius:6px}
@media (prefers-color-scheme:dark){
.bn-ad{color:#e5e7eb;background:#111827;border-color:rgba(255,255,255,.12)}
.bn-body{color:#9ca3af}.bn-url{color:#9ca3af}.bn-cta{color:#93b4fd}
.bn-label{color:#9ca3af;background:rgba(17,24,39,.92)}}
`;

/* ------------------------------------------------------------- bootstrap */

interface PublicApi {
  setConsent(c: Partial<Consent> | boolean): void;
  refresh(): void;
  version: string;
}

(function boot() {
  const existing = (window as unknown as { blissnova?: PublicApi }).blissnova;
  if (existing && typeof existing.refresh === 'function') {
    existing.refresh();
    return;
  }
  const script =
    (document.currentScript as HTMLScriptElement | null) ??
    (document.querySelector('script[data-site-key]') as HTMLScriptElement | null);
  const siteKey = script?.getAttribute('data-site-key') ?? '';
  if (!/^pk_[A-Za-z0-9]{16,40}$/.test(siteKey)) return; // nothing we can serve

  let api = script?.getAttribute('data-api') ?? '';
  if (!api && script?.src) {
    try {
      api = new URL(script.src).origin;
    } catch {
      api = '';
    }
  }
  if (!api) return;

  const tag = new Tag(api, siteKey);
  const consentAttr = script?.getAttribute('data-consent');
  if (consentAttr === 'personalized') tag.setConsent({ personalized: true });
  else if (consentAttr === 'non-personalized') tag.setConsent({ personalized: false });

  const api_: PublicApi = {
    setConsent: (c) => tag.setConsent(c),
    refresh: () => tag.refresh(),
    version: '1',
  };
  (window as unknown as { blissnova: PublicApi }).blissnova = api_;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => tag.start(), { once: true });
  else tag.start();
})();
