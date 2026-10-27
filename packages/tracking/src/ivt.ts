import type { InvalidReason } from '@blissnova/shared';

/**
 * Layered invalid-traffic (IVT) assessment. Hard failures make an event
 * invalid on their own. Soft signals add to an anomaly score; an event is
 * invalid only when the combined score reaches the configured threshold, so
 * a single weak signal (e.g. a shared IP or a high CTR) never condemns
 * traffic by itself.
 */
export interface IvtSignals {
  tokenInvalid?: boolean;
  tokenExpired?: boolean;
  replay?: boolean;
  duplicate?: boolean;
  domainMismatch?: boolean;
  crawler?: boolean;
  siteInactive?: boolean;
  sequenceViolation?: boolean;   // e.g. viewable/click without a render
  trackingDisabled?: boolean;
  // soft signals
  ipRequestsPerMinute?: number;
  maxRequestsPerMinute?: number;
  renderToClickMs?: number | null;
  minRenderToClickMs?: number;
  visitorClicksLastHour?: number;
  maxClicksPerVisitorPerHour?: number;
  missingReferrer?: boolean;
  tokenAgeMs?: number;            // time since token issued
}

export interface IvtResult { valid: boolean; reason: InvalidReason | null; score: number; signals: string[] }

const HARD: Array<[keyof IvtSignals, InvalidReason]> = [
  ['trackingDisabled', 'tracking_disabled'],
  ['tokenInvalid', 'token_invalid'],
  ['tokenExpired', 'token_expired'],
  ['duplicate', 'duplicate'],
  ['replay', 'replay'],
  ['siteInactive', 'site_inactive'],
  ['domainMismatch', 'domain_mismatch'],
  ['crawler', 'crawler'],
  ['sequenceViolation', 'sequence'],
];

export function assessEvent(s: IvtSignals, threshold: number): IvtResult {
  const signals: string[] = [];
  for (const [key, reason] of HARD) {
    if (s[key]) return { valid: false, reason, score: 100, signals: [String(key)] };
  }
  let score = 0;
  let dominant: InvalidReason = 'anomaly_score';
  if (s.ipRequestsPerMinute !== undefined && s.maxRequestsPerMinute) {
    const ratio = s.ipRequestsPerMinute / s.maxRequestsPerMinute;
    if (ratio > 1) {
      const add = Math.min(60, Math.round(30 * ratio));
      score += add;
      signals.push(`rate:${s.ipRequestsPerMinute}/min`);
      dominant = 'rate_anomaly';
    }
  }
  if (s.renderToClickMs !== undefined && s.renderToClickMs !== null && s.minRenderToClickMs !== undefined && s.renderToClickMs < s.minRenderToClickMs) {
    score += 45;
    signals.push(`click_fast:${s.renderToClickMs}ms`);
    dominant = 'click_too_fast';
  }
  if (s.visitorClicksLastHour !== undefined && s.maxClicksPerVisitorPerHour && s.visitorClicksLastHour > s.maxClicksPerVisitorPerHour) {
    score += 50;
    signals.push(`click_burst:${s.visitorClicksLastHour}/h`);
    dominant = 'click_burst';
  }
  if (s.missingReferrer) {
    score += 10;
    signals.push('no_referrer');
  }
  if (s.tokenAgeMs !== undefined && s.tokenAgeMs < 50) {
    score += 20;
    signals.push(`token_age:${s.tokenAgeMs}ms`);
  }
  score = Math.min(100, score);
  if (score >= threshold) return { valid: false, reason: dominant, score, signals };
  return { valid: true, reason: null, score, signals };
}
