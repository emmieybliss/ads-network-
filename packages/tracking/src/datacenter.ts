import { DATACENTER_V4, DATACENTER_V6 } from './datacenter-ranges.generated';

/**
 * IP range matching for cloud and hosting networks. People browse from homes,
 * offices and phones; requests from server ranges are automated (General
 * Invalid Traffic in MRC terms). The bundled list comes from ranges the
 * providers publish themselves (scripts/update-datacenter-ranges.mjs); staff
 * can add ranges and trust ranges (e.g. an office VPN) in settings.
 */
interface Ranges { starts: bigint[]; ends: bigint[] }

export function ipToBigInt(ip: string): { v6: boolean; value: bigint } | null {
  let a = ip.trim();
  if (a.startsWith('[')) a = a.slice(1, a.indexOf(']'));
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) is the IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) a = mapped[1]!;
  if (a.includes('.')) {
    const p = a.split('.');
    if (p.length !== 4) return null;
    let v = 0n;
    for (const x of p) {
      if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return null;
      v = (v << 8n) | BigInt(Number(x));
    }
    return { v6: false, value: v };
  }
  if (!a.includes(':')) return null;
  const parts = a.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const groups = parts.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return { v6: true, value: v };
}

export function parseCidr(cidr: string): { v6: boolean; start: bigint; end: bigint } | null {
  const [addr, bitsStr] = cidr.trim().split('/');
  const ip = addr ? ipToBigInt(addr) : null;
  if (!ip) return null;
  const max = ip.v6 ? 128 : 32;
  const bits = bitsStr === undefined ? max : Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  const size = 1n << BigInt(max - bits);
  const start = (ip.value / size) * size;
  return { v6: ip.v6, start, end: start + size - 1n };
}

function decode(packed: string): Ranges {
  const starts: bigint[] = [];
  const ends: bigint[] = [];
  for (const pair of packed.split(' ')) {
    if (!pair) continue;
    const [s, e] = pair.split('-');
    starts.push(base36(s!));
    ends.push(base36(e!));
  }
  return { starts, ends };
}

function base36(s: string): bigint {
  let v = 0n;
  for (const ch of s) v = v * 36n + BigInt(parseInt(ch, 36));
  return v;
}

function fromCidrs(list: readonly string[], v6: boolean): Ranges {
  const rs = list.map(parseCidr).filter((r): r is NonNullable<typeof r> => !!r && r.v6 === v6).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const starts: bigint[] = [];
  const ends: bigint[] = [];
  for (const r of rs) {
    const i = ends.length - 1;
    if (i >= 0 && r.start <= ends[i]! + 1n) { if (r.end > ends[i]!) ends[i] = r.end; } else { starts.push(r.start); ends.push(r.end); }
  }
  return { starts, ends };
}

function contains(r: Ranges, v: bigint): boolean {
  let lo = 0;
  let hi = r.starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (v < r.starts[mid]!) hi = mid - 1;
    else if (v > r.ends[mid]!) lo = mid + 1;
    else return true;
  }
  return false;
}

let bundled: { v4: Ranges; v6: Ranges } | null = null;
const custom = new Map<string, { v4: Ranges; v6: Ranges }>();

function compiled(list: readonly string[]) {
  const key = list.join(',');
  let c = custom.get(key);
  if (!c) {
    c = { v4: fromCidrs(list, false), v6: fromCidrs(list, true) };
    if (custom.size > 20) custom.clear();
    custom.set(key, c);
  }
  return c;
}

export type IpNetwork = 'datacenter' | 'trusted' | 'other';

/**
 * Classifies a raw client IP. Trusted ranges win over everything; extra
 * ranges are staff additions on top of the bundled provider list.
 */
export function classifyIp(ip: string | null | undefined, opts: { extra?: readonly string[]; trusted?: readonly string[]; bundled?: boolean } = {}): IpNetwork {
  if (!ip) return 'other';
  const a = ipToBigInt(ip);
  if (!a) return 'other';
  const pick = (r: { v4: Ranges; v6: Ranges }) => (a.v6 ? r.v6 : r.v4);
  if (opts.trusted?.length && contains(pick(compiled(opts.trusted)), a.value)) return 'trusted';
  if (opts.extra?.length && contains(pick(compiled(opts.extra)), a.value)) return 'datacenter';
  if (opts.bundled !== false) {
    bundled ??= { v4: decode(DATACENTER_V4), v6: decode(DATACENTER_V6) };
    if (contains(pick(bundled), a.value)) return 'datacenter';
  }
  return 'other';
}

export function isValidCidr(c: string): boolean {
  return parseCidr(c) !== null && /\//.test(c);
}

export { DATACENTER_RANGES_SOURCES, DATACENTER_RANGES_UPDATED } from './datacenter-ranges.generated';
