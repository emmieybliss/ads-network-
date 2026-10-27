/**
 * Formatting. Money arrives from the API as integer micros in strings
 * (1 unit = 1,000,000 micros) and is formatted with BigInt arithmetic so no
 * amount ever passes through a float.
 */
export function formatMicros(micros: string | number | bigint | null | undefined, currency = 'USD', opts: { precise?: boolean } = {}): string {
  if (micros === null || micros === undefined || micros === '') return '—';
  let v: bigint;
  try {
    v = BigInt(micros);
  } catch {
    return '—';
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const decimals = opts.precise ? 4 : 2;
  const scale = 10n ** BigInt(6 - decimals);
  const rounded = (v + scale / 2n) / scale; // half-up at the display precision
  const whole = rounded / 10n ** BigInt(decimals);
  const frac = (rounded % 10n ** BigInt(decimals)).toString().padStart(decimals, '0');
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '';
  const body = `${sym}${wholeStr}.${frac}${sym ? '' : ` ${currency}`}`;
  return neg ? `−${body}` : body;
}

/** "12.50" -> micros string, for form inputs. Returns null for invalid input. */
export function toMicrosString(amount: string): string | null {
  const m = /^\s*(\d{1,12})(?:\.(\d{1,6}))?\s*$/.exec(amount);
  if (!m) return null;
  return (BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'))).toString();
}

/** micros -> "12.50" for pre-filling inputs. */
export function microsToInput(micros: string | null | undefined): string {
  if (!micros) return '';
  const v = BigInt(micros);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac.length < 2 ? frac.padEnd(2, '0') : frac}` : `${whole}`;
}

export function formatNumber(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === '') return '—';
  const v = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US');
}

export function formatPercent(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export function formatDate(d: string | Date | null | undefined, withTime = false): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

export function timeAgo(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const t = (typeof d === 'string' ? new Date(d) : d).getTime();
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function humanize(s: string | null | undefined): string {
  if (!s) return '—';
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function bpsToPercent(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '—';
  return `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
