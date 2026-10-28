/**
 * Consent signals from the page, decided on the server so one place says
 * whether an ad request may be personalized.
 *
 * Supported signals:
 * - IAB TCF v2.2 TC strings (Europe). Personalization needs a configured IAB
 *   vendor id (TCF_VENDOR_ID) with vendor consent and consent for purposes 1
 *   (store/access on a device), 3 (create a personalized ads profile) and 4
 *   (use a profile to select ads). Without a registered vendor id we never
 *   claim TCF consent, so ads under GDPR stay contextual.
 * - IAB GPP strings (US states). usnat and the older US Privacy (uspv1)
 *   section are decoded; any opt-out of sale, sharing or targeted advertising
 *   means contextual ads. Other applicable sections (individual US states,
 *   Canada) are not decoded yet, so they are treated as an opt-out.
 * - Global Privacy Control (Sec-GPC header or navigator.globalPrivacyControl).
 * - The publisher's own setConsent() / data-consent: "off" always wins; "on"
 *   counts only where no CMP signal says GDPR applies.
 *
 * Contextual ads use no visitor id and store nothing on the device, so they
 * are what we fall back to whenever a signal is missing, invalid or negative.
 */

export interface ConsentSignals {
  personalized?: boolean;
  gdprApplies?: boolean;
  tcString?: string;
  gpp?: string;
  gppSections?: number[];
  usp?: string;
  gpc?: boolean;
}

export type ConsentReason =
  | 'allowed' | 'network_off' | 'no_consent' | 'gpc' | 'usp_opt_out' | 'gpp_opt_out' | 'gpp_unsupported'
  | 'gpp_invalid' | 'tcf_missing' | 'tcf_invalid' | 'tcf_no_vendor_id' | 'tcf_denied';

export interface ConsentDecision { personalized: boolean; reason: ConsentReason }

/* ------------------------------------------------------------- bit reading */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url (IAB flavour, no padding) to a string of '0'/'1'. Null when invalid. */
export function base64UrlBits(s: string): string | null {
  let out = '';
  for (const ch of s.replace(/=+$/, '')) {
    const v = B64.indexOf(ch === '+' ? '-' : ch === '/' ? '_' : ch);
    if (v < 0) return null;
    out += v.toString(2).padStart(6, '0');
  }
  return out;
}

class Bits {
  pos = 0;
  constructor(private readonly b: string) {}
  int(n: number): number {
    if (this.pos + n > this.b.length) throw new RangeError('truncated');
    const v = parseInt(this.b.slice(this.pos, this.pos + n) || '0', 2);
    this.pos += n;
    return v;
  }
  bool(): boolean { return this.int(1) === 1; }
  field(n: number): boolean[] { const out: boolean[] = []; for (let i = 0; i < n; i++) out.push(this.bool()); return out; }
  /** Fibonacci-coded integer as used by GPP: bits LSB first, ended by "11". */
  fib(): number {
    const seq = [1, 2];
    let v = 0;
    let prev = false;
    for (let i = 0; ; i++) {
      const bit = this.bool();
      if (bit && prev) return v;
      while (seq.length <= i) seq.push(seq[seq.length - 1]! + seq[seq.length - 2]!);
      if (bit) v += seq[i]!;
      prev = bit;
      if (i > 40) throw new RangeError('fibonacci overflow');
    }
  }
}

/* -------------------------------------------------------------------- TCF */

export interface TcData { version: number; policyVersion: number; cmpId: number; purposeConsents: boolean[]; vendorConsent: (id: number) => boolean }

/** Decode the core segment of a TCF v2 TC string. Null when it is not one. */
export function decodeTcString(tc: string): TcData | null {
  const core = tc.split('.')[0] ?? '';
  if (!core || core.length > 4096) return null;
  const bits = base64UrlBits(core);
  if (!bits) return null;
  try {
    const r = new Bits(bits);
    const version = r.int(6);
    if (version !== 2) return null;
    r.int(36); r.int(36); // created, last updated
    const cmpId = r.int(12);
    r.int(12); r.int(6); r.int(12); r.int(12); // cmp version, consent screen, language, vendor list version
    const policyVersion = r.int(6);
    r.int(1); r.int(1); r.int(12); // service specific, non-standard texts, special feature opt-ins
    const purposeConsents = r.field(24);
    r.int(24); r.int(1); r.int(12); // purpose LI transparency, purpose one treatment, publisher country
    const maxVendorId = r.int(16);
    let vendorConsent: (id: number) => boolean;
    if (r.bool()) {
      const ranges: Array<[number, number]> = [];
      const n = r.int(12);
      for (let i = 0; i < n; i++) {
        const isRange = r.bool();
        const start = r.int(16);
        ranges.push([start, isRange ? r.int(16) : start]);
      }
      vendorConsent = (id) => ranges.some(([a, b]) => id >= a && id <= b);
    } else {
      const field = r.field(maxVendorId);
      vendorConsent = (id) => id >= 1 && id <= maxVendorId && field[id - 1] === true;
    }
    return { version, policyVersion, cmpId, purposeConsents, vendorConsent };
  } catch {
    return null;
  }
}

/** Purposes 1, 3 and 4 plus vendor consent: what personalized ads need. */
export function tcfAllowsPersonalization(tc: TcData, vendorId: number): boolean {
  return [1, 3, 4].every((p) => tc.purposeConsents[p - 1] === true) && tc.vendorConsent(vendorId);
}

/* -------------------------------------------------------------------- GPP */

export const GPP_SECTION = { tcfeuv2: 2, header: 3, tcfcav1: 5, uspv1: 6, usnat: 7 } as const;

/** Section ids listed in a GPP string's header. Null when it is not a GPP v1 string. */
export function gppSectionIds(gpp: string): number[] | null {
  const head = gpp.split('~')[0] ?? '';
  const bits = base64UrlBits(head);
  if (!bits) return null;
  try {
    const r = new Bits(bits);
    if (r.int(6) !== GPP_SECTION.header || r.int(6) !== 1) return null;
    const n = r.int(12);
    const ids: number[] = [];
    let last = 0;
    for (let i = 0; i < n && ids.length < 100; i++) {
      if (r.bool()) {
        const start = last + r.fib();
        const end = start + r.fib();
        for (let id = start; id <= end && ids.length < 100; id++) ids.push(id);
        last = end;
      } else {
        last += r.fib();
        ids.push(last);
      }
    }
    return ids;
  } catch {
    return null;
  }
}

/** The usnat core segment's opt-outs, plus its optional GPC sub-segment. */
export function decodeUsNat(section: string): { optedOut: boolean; gpc: boolean } | null {
  const [core, ...subs] = section.split('.');
  const bits = core ? base64UrlBits(core) : null;
  if (!bits) return null;
  try {
    const r = new Bits(bits);
    const version = r.int(6);
    if (version < 1) return null;
    r.int(2); r.int(2); r.int(2); r.int(2); r.int(2); r.int(2); // notices
    const sale = r.int(2), sharing = r.int(2), targeted = r.int(2); // 1 = opted out
    let gpc = false;
    for (const s of subs) {
      const sb = base64UrlBits(s);
      if (!sb || sb.length < 3) continue;
      const sr = new Bits(sb);
      if (sr.int(2) === 1) gpc ||= sr.bool();
    }
    return { optedOut: sale === 1 || sharing === 1 || targeted === 1, gpc };
  } catch {
    return null;
  }
}

/** US Privacy string "1YNN": the third character is the opt-out of sale. */
export function uspOptedOut(usp: string): boolean | null {
  if (!/^1[YN-][YN-][YN-]$/i.test(usp)) return null;
  return usp[2]!.toUpperCase() === 'Y';
}

/* --------------------------------------------------------------- decision */

export function decideConsent(sig: ConsentSignals | undefined, opts: { personalizedAllowed: boolean; vendorId: number | undefined; secGpc: boolean }): ConsentDecision {
  const no = (reason: ConsentReason): ConsentDecision => ({ personalized: false, reason });
  if (!opts.personalizedAllowed) return no('network_off');
  const s = sig ?? {};
  if (opts.secGpc || s.gpc) return no('gpc');
  // The publisher can always turn personalization off, whatever a CMP says.
  if (s.personalized === false) return no('no_consent');

  if (s.usp) {
    const out = uspOptedOut(s.usp);
    if (out !== false) return no('usp_opt_out');
  }

  let tcString = s.tcString;
  if (s.gpp) {
    const ids = gppSectionIds(s.gpp);
    if (!ids) return no('gpp_invalid');
    const parts = s.gpp.split('~').slice(1);
    // Only sections the CMP says apply to this visitor count; without that list, all present ones do.
    const applicable = s.gppSections?.filter((n) => n > 0);
    const applies = (id: number) => (s.gppSections ? (applicable ?? []).includes(id) : true);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      if (!applies(id)) continue;
      const body = parts[i] ?? '';
      if (id === GPP_SECTION.tcfeuv2) { tcString ??= body; continue; }
      if (id === GPP_SECTION.uspv1) { if (uspOptedOut(body) !== false) return no('usp_opt_out'); continue; }
      if (id === GPP_SECTION.usnat) {
        const u = decodeUsNat(body);
        if (!u) return no('gpp_invalid');
        if (u.optedOut || u.gpc) return no(u.gpc ? 'gpc' : 'gpp_opt_out');
        continue;
      }
      return no('gpp_unsupported');
    }
  }

  const gdpr = s.gdprApplies === true || (s.gdprApplies === undefined && !!tcString);
  if (gdpr) {
    if (!tcString) return no('tcf_missing');
    const tc = decodeTcString(tcString);
    if (!tc) return no('tcf_invalid');
    if (![1, 3, 4].every((p) => tc.purposeConsents[p - 1] === true)) return no('tcf_denied');
    if (!opts.vendorId) return no('tcf_no_vendor_id');
    return tcfAllowsPersonalization(tc, opts.vendorId) ? { personalized: true, reason: 'allowed' } : no('tcf_denied');
  }
  return s.personalized ? { personalized: true, reason: 'allowed' } : no('no_consent');
}
