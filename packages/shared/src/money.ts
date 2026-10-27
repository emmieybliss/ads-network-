/**
 * Money is stored as integer "micros" (1 currency unit = 1,000,000 micros)
 * in bigint/BIGINT columns. Per-impression CPM charges are fractions of a
 * cent, so minor units (cents) cannot represent them exactly; micros can.
 * Floating point is never used for accounting.
 */
export const MICROS_PER_UNIT = 1_000_000n;
export const MICROS_PER_MINOR = 10_000n; // 1 cent = 10,000 micros (2-decimal currencies)

export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'NGN', 'CAD', 'AUD'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export function toMicros(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  const s = typeof value === 'number' ? value.toFixed(6) : value.trim();
  if (!/^-?\d+(\.\d{1,6})?$/.test(s)) throw new Error(`Invalid money amount: ${value}`);
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const micros = BigInt(whole!) * MICROS_PER_UNIT + BigInt((frac + '000000').slice(0, 6));
  return neg ? -micros : micros;
}

/** Format micros as a fixed decimal string, e.g. 1234500n -> "1.2345" (trims to at least 2 decimals). */
export function formatMicros(micros: bigint | string | number, decimals = 2): string {
  const v = BigInt(micros);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / MICROS_PER_UNIT;
  let frac = (abs % MICROS_PER_UNIT).toString().padStart(6, '0');
  frac = decimals >= 6 ? frac : frac.slice(0, decimals);
  return `${neg ? '-' : ''}${whole.toString()}${decimals > 0 ? '.' + frac : ''}`;
}

export function formatMoney(micros: bigint | string | number, currency: string, decimals = 2): string {
  const s = formatMicros(micros, decimals);
  const [w, f] = s.replace('-', '').split('.');
  const grouped = w!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${s.startsWith('-') ? '-' : ''}${currency} ${grouped}${f !== undefined ? '.' + f : ''}`;
}

/** Cost of a single impression for a CPM rate (rate is per 1000 impressions). Rounded down. */
export function cpmToImpressionMicros(cpmMicros: bigint): bigint {
  return cpmMicros / 1000n;
}

/** Apply basis points (1/100 of a percent) rounding down. */
export function applyBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new Error('bps must be an integer 0..10000');
  return (amount * BigInt(bps)) / 10000n;
}
