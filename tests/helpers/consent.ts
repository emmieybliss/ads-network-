/** Encoders for IAB consent strings, so tests can build exactly the signal they need. */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toB64(bits: string): string {
  const padded = bits.padEnd(Math.ceil(bits.length / 6) * 6, '0');
  let out = '';
  for (let i = 0; i < padded.length; i += 6) out += B64[parseInt(padded.slice(i, i + 6), 2)];
  return out;
}
const int = (v: number, n: number) => v.toString(2).padStart(n, '0');
const field = (set: number[], n: number) => Array.from({ length: n }, (_, i) => (set.includes(i + 1) ? '1' : '0')).join('');

/** A TCF v2.2 core TC string with the given purpose consents and vendor consents. */
export function tcString(opts: { purposes: number[]; vendors: number[]; ranges?: boolean; version?: number }): string {
  const ds = int(Math.floor(Date.UTC(2026, 9, 1) / 100), 36);
  let b = int(opts.version ?? 2, 6) + ds + ds + int(300, 12) + int(1, 12) + int(1, 6) + int(4 * 64 + 13, 12) + int(150, 12) + int(4, 6)
    + '1' + '0' + int(0, 12) + field(opts.purposes, 24) + int(0, 24) + '0' + int(0, 12);
  const max = Math.max(0, ...opts.vendors);
  if (opts.ranges) {
    b += int(max, 16) + '1' + int(opts.vendors.length, 12) + opts.vendors.map((v) => '0' + int(v, 16)).join('');
  } else {
    b += int(max, 16) + '0' + field(opts.vendors, max);
  }
  b += int(0, 16) + '0'; // empty legitimate-interest vendor section
  b += int(0, 12); // no publisher restrictions
  return toB64(b);
}

function fib(n: number): string {
  const seq = [1, 2];
  while (seq[seq.length - 1]! <= n) seq.push(seq[seq.length - 1]! + seq[seq.length - 2]!);
  const bits = new Array(seq.length).fill('0');
  let rest = n;
  for (let i = seq.length - 1; i >= 0; i--) if (seq[i]! <= rest) { bits[i] = '1'; rest -= seq[i]!; }
  return bits.join('').replace(/0+$/, '') + '1';
}

/** A GPP v1 string with the given sections, in id order. */
export function gppString(sections: Array<{ id: number; body: string }>): string {
  const sorted = [...sections].sort((a, b) => a.id - b.id);
  let last = 0;
  let b = int(3, 6) + int(1, 6) + int(sorted.length, 12);
  for (const s of sorted) { b += '0' + fib(s.id - last); last = s.id; }
  return [toB64(b), ...sorted.map((s) => s.body)].join('~');
}

/** A usnat core segment; 1 = opted out, 2 = did not opt out. */
export function usNat(opts: { sale?: number; sharing?: number; targeted?: number; gpc?: boolean }): string {
  const core = toB64(int(1, 6) + int(1, 2).repeat(6) + int(opts.sale ?? 2, 2) + int(opts.sharing ?? 2, 2) + int(opts.targeted ?? 2, 2) + '0'.repeat(40));
  return opts.gpc === undefined ? core : `${core}.${toB64(int(1, 2) + (opts.gpc ? '1' : '0'))}`;
}
