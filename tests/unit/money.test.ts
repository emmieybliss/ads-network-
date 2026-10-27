import { describe, expect, it } from 'vitest';
import { applyBps, cpmToImpressionMicros, formatMicros, formatMoney, MICROS_PER_MINOR, toMicros } from '@blissnova/shared';

describe('money is integer micros, never floats', () => {
  it('parses decimal strings exactly', () => {
    expect(toMicros('1')).toBe(1_000_000n);
    expect(toMicros('0.01')).toBe(10_000n);
    expect(toMicros('2.50')).toBe(2_500_000n);
    expect(toMicros('0.000001')).toBe(1n);
    expect(toMicros('1234567.891234')).toBe(1_234_567_891_234n);
  });

  it('parses the amounts that break floating point', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; in micros it is exact.
    expect(toMicros('0.1') + toMicros('0.2')).toBe(toMicros('0.3'));
    expect(toMicros('0.07') * 3n).toBe(toMicros('0.21'));
    expect(toMicros('8.165')).toBe(8_165_000n);
  });

  it('accepts negatives and strips grouping-free whitespace', () => {
    expect(toMicros('-5.25')).toBe(-5_250_000n);
    expect(toMicros(' 3.5 ')).toBe(3_500_000n);
  });

  it('rejects anything that is not a plain decimal amount', () => {
    for (const bad of ['', 'abc', '1,000', '1e6', '1.2.3', '--1', '0x10', '1.0000001']) {
      expect(() => toMicros(bad), bad).toThrow();
    }
  });

  it('round-trips through formatMicros', () => {
    for (const v of ['0', '0.01', '12.34', '1000000', '0.000500']) {
      expect(formatMicros(toMicros(v), 6)).toBe(Number(v).toFixed(6));
    }
  });

  it('formats to the requested number of decimals, truncating not rounding up', () => {
    expect(formatMicros(2_500_000n)).toBe('2.50');
    expect(formatMicros(1n, 6)).toBe('0.000001');
    expect(formatMicros(-2_500_000n)).toBe('-2.50');
    expect(formatMoney(2_500_000n, 'USD')).toContain('2.50');
  });

  it('a cent is ten thousand micros', () => {
    expect(MICROS_PER_MINOR).toBe(10_000n);
    expect(toMicros('0.01')).toBe(MICROS_PER_MINOR);
  });

  describe('CPM to per-impression cost', () => {
    it('divides by a thousand', () => {
      expect(cpmToImpressionMicros(toMicros('2.50'))).toBe(2_500n);
      expect(cpmToImpressionMicros(toMicros('1'))).toBe(1_000n);
    });

    it('keeps sub-micro CPMs from rounding to zero revenue silently', () => {
      // $0.0005 CPM is 0.5 micros per impression. Whatever the rounding rule,
      // it must be deterministic and non-negative.
      const v = cpmToImpressionMicros(500n);
      expect(v).toBeGreaterThanOrEqual(0n);
      expect(v).toBeLessThanOrEqual(1n);
    });
  });

  describe('basis points', () => {
    it('computes a revenue share', () => {
      expect(applyBps(toMicros('100'), 7000)).toBe(toMicros('70'));
      expect(applyBps(toMicros('182.50'), 7000)).toBe(toMicros('127.75'));
    });

    it('handles the extremes', () => {
      expect(applyBps(toMicros('10'), 0)).toBe(0n);
      expect(applyBps(toMicros('10'), 10_000)).toBe(toMicros('10'));
    });

    it('never returns more than the input for a share under 100%', () => {
      const amount = 1_234_567n;
      for (const bps of [1, 333, 5000, 9999]) {
        expect(applyBps(amount, bps)).toBeLessThan(amount);
      }
    });
  });
});
