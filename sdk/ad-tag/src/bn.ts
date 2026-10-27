/**
 * BlissNova ad tag.
 *
 * Loaded by publishers as one self-contained snippet per placement:
 *   <div id="bn-ad-slot-sidebar_300x250" data-bn-slot="sidebar_300x250"></div>
 *   <script async src="https://<api-host>/sdk/ads.js"
 *           data-site-key="pk_..." data-slot="sidebar_300x250"></script>
 *
 * or with the script once and any number of <div data-bn-slot="..."> elements.
 * A script with data-slot but no matching container gets one created just
 * before it, so the snippet works even if the div is left out.
 *
 * Design notes:
 * - No framework, no dependencies, no cookies written by this script.
 * - Creative content is inserted with textContent / explicit element
 *   properties only. Nothing from the API is ever passed to innerHTML.
 * - Each slot renders inside a closed shadow root so publisher CSS cannot
 *   restyle (or hide) the required "Sponsored" label.
 * - Consent: the tag reads an IAB TCF v2.2 CMP (__tcfapi), a GPP CMP
 *   (__gpp), the US Privacy API (__uspapi) and Global Privacy Control, and
 *   sends the signals with each ad request. The server decides whether the
 *   ad may be personalized. Until a CMP has answered (or 2 seconds pass) no
 *   ad is requested.
 * - A visitor id is stored in localStorage only after the server says
 *   personalization is allowed; any signal against it deletes the id.
 * - Any failure collapses the slot quietly. We never block page rendering and
 *   we never retry in a loop.
 */

type Format = 'image' | 'text' | 'native';

interface AdPayload {
  format: Format;
  token: string;
  clickUrl: string;
  width: number | null;
  height: number | null;
  image?: { url: string; alt: string };
  text?: { headline: string; body: string; cta: string; displayUrl: string };
  native?: { imageUrl: string; alt: string; headline: string; body: string; cta: string; displayUrl: string; sponsor: string };
}
interface ServeResponse {
  status: 'ok' | 'inactive' | 'blocked' | 'disabled';
  ads: Array<{ slot: string; ad: AdPayload | null }>;
  privacy?: { personalization: boolean; reason: string };
}
interface Consent {
  personalized: boolean;
  gdprApplies?: boolean;
}
/** Signals read from consent management platforms on the page. */
interface CmpSignals {
  gdprApplies?: boolean;
  tcString?: string;
  storageConsent?: boolean; // TCF purpose 1
  gpp?: string;
  gppSections?: number[];
  usp?: string;
  gpc?: boolean;
}
type CmpFn = (...args: unknown[]) => void;

const VID_KEY = 'bn_vid';
const SLOT_SELECTOR = '[data-bn-slot]';
const VIEWABLE_RATIO = 0.5;
const VIEWABLE_MS = 1000;
const BATCH_MS = 1500;
const MAX_BATCH = 20;
const CMP_TIMEOUT_MS = 2000;

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

/** The stored visitor id; a new one is created only when `create` is set. */
function readVid(create: boolean): string | undefined {
  const s = store();
  if (!s) return undefined;
  try {
    let v = s.getItem(VID_KEY);
    if (!v || !/^[A-Za-z0-9_-]{16,64}$/.test(v)) {
      if (!create) return undefined;
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

/* ---------------------------------------------------------------- consent */

function cmpFn(name: string): CmpFn | null {
  const f = (window as unknown as Record<string, unknown>)[name];
  return typeof f === 'function' ? (f as CmpFn) : null;
}

/**
 * Listen to the CMPs on the page. `update` gets every change; the returned
 * promise settles when each CMP present has given a usable answer, or after
 * CMP_TIMEOUT_MS, whichever is first.
 */
function watchCmps(update: (s: CmpSignals) => void): Promise<void> {
  const waits: Array<Promise<void>> = [];
  const gpc = (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
  if (gpc) update({ gpc: true });

  const tcf = cmpFn('__tcfapi');
  if (tcf) {
    waits.push(new Promise<void>((done) => {
      try {
        tcf('addEventListener', 2, (d: { gdprApplies?: boolean; tcString?: string; eventStatus?: string; purpose?: { consents?: Record<string, boolean> } } | null, ok: boolean) => {
          if (!ok || !d) return;
          update({ gdprApplies: d.gdprApplies, tcString: d.tcString || undefined, storageConsent: d.purpose?.consents?.['1'] === true });
          // cmpuishown: the visitor has not chosen yet; keep waiting for that.
          if (d.gdprApplies === false || d.eventStatus === 'tcloaded' || d.eventStatus === 'useractioncomplete') done();
        });
      } catch { done(); }
    }));
  }

  const gppApi = cmpFn('__gpp');
  if (gppApi) {
    waits.push(new Promise<void>((done) => {
      const take = (raw: unknown) => {
        const r = raw as { pingData?: unknown } | null;
        const p = (r && typeof r === 'object' && 'pingData' in r ? r.pingData : r) as { gppString?: string; applicableSections?: number[]; signalStatus?: string } | null;
        if (!p || typeof p !== 'object') return;
        if (typeof p.gppString === 'string') update({ gpp: p.gppString || undefined, gppSections: Array.isArray(p.applicableSections) ? p.applicableSections.slice(0, 40) : undefined });
        if (p.signalStatus !== 'not ready') done();
      };
      try {
        gppApi('addEventListener', (d: unknown, ok: boolean) => { if (ok) take(d); });
        gppApi('ping', (d: unknown, ok: boolean) => { if (ok !== false) take(d); });
      } catch { done(); }
    }));
  }

  const usp = cmpFn('__uspapi');
  if (usp) {
    waits.push(new Promise<void>((done) => {
      try {
        usp('getUSPData', 1, (d: { uspString?: string } | null, ok: boolean) => {
          if (ok && d && typeof d.uspString === 'string') update({ usp: d.uspString });
          done();
        });
      } catch { done(); }
    }));
  }

  if (!waits.length) return Promise.resolve();
  return Promise.race([Promise.all(waits).then(() => undefined), new Promise<void>((r) => setTimeout(r, CMP_TIMEOUT_MS))]);
}

/* ------------------------------------------------------------- the runtime */

class Tag {
  private readonly api: string;
  private readonly siteKey: string;
  private readonly pv = randomId(16);
  private consent: Consent = { personalized: false };
  private consentSet = false;
  private cmp: CmpSignals = {};
  private cmpReady: Promise<void> = Promise.resolve();
  /** The server's last word on personalization for this visitor. */
  private privacy: { personalization: boolean; reason: string } | null = null;
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
    this.consent = next;
    this.consentSet = true;
    if (!next.personalized) dropVid();
    if (this.started) this.scan();
  }

  /** Publisher API: what the last ad request was allowed to do, for debugging consent setups. */
  getPrivacy() {
    const c = this.cmp;
    return {
      personalization: this.privacy?.personalization ?? false,
      reason: this.privacy?.reason ?? 'pending',
      signals: { tcf: c.tcString !== undefined || c.gdprApplies !== undefined, gdprApplies: c.gdprApplies, gpp: !!c.gpp, usp: c.usp, gpc: !!c.gpc, publisher: this.consentSet ? this.consent.personalized : undefined },
    };
  }

  /** Whether the device may hold a visitor id right now, from the page's own signals. */
  private deviceStorageAllowed(): boolean {
    if (this.cmp.gpc) return false;
    if (this.cmp.gdprApplies && !this.cmp.storageConsent) return false;
    if (this.consentSet && !this.consent.personalized) return false;
    return this.privacy?.personalization !== false;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.cmpReady = watchCmps((s) => {
      this.cmp = { ...this.cmp, ...s };
      if (!this.deviceStorageAllowed()) dropVid();
    });
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
    await this.cmpReady;

    const c = this.cmp;
    const storageOk = this.deviceStorageAllowed();
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
          consent: {
            personalized: this.consentSet ? this.consent.personalized : undefined,
            gdprApplies: c.gdprApplies ?? (this.consentSet ? this.consent.gdprApplies : undefined),
            tcString: c.tcString, gpp: c.gpp, gppSections: c.gppSections, usp: c.usp, gpc: c.gpc || undefined,
          },
          vid: storageOk ? readVid(this.privacy?.personalization === true) : undefined,
          pv: this.pv,
        }),
      });
      if (!r.ok) throw new Error(`serve ${r.status}`);
      res = (await r.json()) as ServeResponse;
    } catch {
      for (const el of byslot.values()) collapse(el);
      return;
    }
    if (res.privacy) {
      this.privacy = res.privacy;
      // Allowed: keep an id for the next requests. Not allowed: remove any stored one.
      if (res.privacy.personalization && this.deviceStorageAllowed()) readVid(true);
      else dropVid();
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
    host.setAttribute('data-bn-state', 'filled');
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
    } else if (ad.format === 'native' && ad.native) {
      // Native ads match the flow of the page but always say who paid for them,
      // above the headline, so they cannot pass as editorial content.
      const n = ad.native;
      frame.classList.add('bn-native-ad');
      const img = document.createElement('img');
      img.className = 'bn-native-img';
      img.src = n.imageUrl;
      img.alt = n.alt;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => collapse(host));
      const box = document.createElement('div');
      box.className = 'bn-native';
      const disclosure = document.createElement('div');
      disclosure.className = 'bn-disclosure';
      disclosure.textContent = n.sponsor ? `Sponsored · ${n.sponsor}` : 'Sponsored';
      const h = document.createElement('div');
      h.className = 'bn-headline';
      h.textContent = n.headline;
      box.appendChild(disclosure);
      box.appendChild(h);
      if (n.body) {
        const b = document.createElement('div');
        b.className = 'bn-body';
        b.textContent = n.body;
        box.appendChild(b);
      }
      const meta = document.createElement('div');
      meta.className = 'bn-meta';
      const url = document.createElement('span');
      url.className = 'bn-url';
      url.textContent = n.displayUrl;
      meta.appendChild(url);
      if (n.cta) {
        const cta = document.createElement('span');
        cta.className = 'bn-cta';
        cta.textContent = n.cta;
        meta.appendChild(cta);
      }
      box.appendChild(meta);
      link.appendChild(img);
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
    // Native ads carry their disclosure in the card itself.
    if (ad.format !== 'native') frame.appendChild(label);
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
.bn-native-img{display:block;width:100%;aspect-ratio:1.91/1;object-fit:cover;border:0;background:#f3f4f6}
.bn-native{padding:12px 14px 14px}
.bn-disclosure{font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:#6b7280;margin-bottom:6px}
.bn-label{position:absolute;right:0;bottom:0;padding:2px 6px;font:500 10px/1.3 system-ui,sans-serif;letter-spacing:.02em;color:#6b7280;background:rgba(255,255,255,.92);border-top-left-radius:6px}
@media (prefers-color-scheme:dark){
.bn-ad{color:#e5e7eb;background:#111827;border-color:rgba(255,255,255,.12)}
.bn-body{color:#9ca3af}.bn-url{color:#9ca3af}.bn-cta{color:#93b4fd}
.bn-label{color:#9ca3af;background:rgba(17,24,39,.92)}
.bn-disclosure{color:#9ca3af}.bn-native-img{background:#1f2937}}
`;

/* ------------------------------------------------------------- bootstrap */

interface PublicApi {
  setConsent(c: Partial<Consent> | boolean): void;
  getPrivacy(): ReturnType<Tag['getPrivacy']>;
  refresh(): void;
  version: string;
}

const SLOT_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** Make sure every <script data-slot> on the page has a container to fill. */
function ensureSlotContainers(): void {
  const scripts = Array.prototype.slice.call(document.querySelectorAll('script[data-site-key][data-slot]')) as HTMLScriptElement[];
  for (const sc of scripts) {
    const slot = sc.getAttribute('data-slot') ?? '';
    if (!SLOT_RE.test(slot)) continue;
    if (document.querySelector(`[data-bn-slot="${slot}"]`)) continue;
    const byId = document.getElementById(`bn-ad-slot-${slot}`);
    if (byId) {
      byId.setAttribute('data-bn-slot', slot);
      continue;
    }
    const div = document.createElement('div');
    div.id = `bn-ad-slot-${slot}`;
    div.setAttribute('data-bn-slot', slot);
    sc.parentNode?.insertBefore(div, sc);
  }
}

(function boot() {
  ensureSlotContainers();
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
    getPrivacy: () => tag.getPrivacy(),
    refresh: () => tag.refresh(),
    version: '1',
  };
  (window as unknown as { blissnova: PublicApi }).blissnova = api_;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => tag.start(), { once: true });
  else tag.start();
})();
