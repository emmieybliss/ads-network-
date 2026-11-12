/** Plain-language names for invalid-traffic reasons and signals, shared by the staff and publisher pages. */
export const REASON_LABELS: Record<string, string> = {
  duplicate: 'Duplicate event',
  token_invalid: 'Forged or damaged tracking token',
  token_expired: 'Expired tracking token',
  replay: 'Replayed event',
  domain_mismatch: 'Shown on a site that is not yours',
  crawler: 'Known bot or crawler',
  rate_anomaly: 'Too many requests from one network',
  sequence: 'Click or view without a real impression',
  click_too_fast: 'Clicked too soon after the ad appeared',
  click_burst: 'Too many clicks in an hour',
  site_inactive: 'Site or account not approved',
  manual_exclusion: 'Removed by our review team',
  tracking_disabled: 'Tracking switched off',
  anomaly_score: 'Several weak warning signs together',
  datacenter: 'Cloud or hosting network (not a person)',
  automation: 'Automated browser',
  click_pattern: 'Clicks on a machine-regular rhythm',
  ivt_clawback: 'Removed by the automatic invalid-traffic check',
};

export const SIGNAL_LABELS: Record<string, string> = {
  webdriver: 'WebDriver browser',
  automation_globals: 'Automation tool detected',
  synthetic_click: 'Click made by a script',
  headless_window: 'Headless window',
  chrome_mismatch: 'Browser does not match its user agent',
  zero_screen: 'No screen',
  no_languages: 'No browser languages',
  no_pointer: 'No mouse movement before the click',
  no_accept_language: 'No Accept-Language header',
  no_fetch_metadata: 'Missing browser fetch headers',
  datacenter_ip: 'Data-center IP',
  automation: 'Automated browser',
  datacenter: 'Data-center IP',
  crawler: 'Bot user agent',
  roboticClicks: 'Machine-regular clicks',
  sequenceViolation: 'No real impression first',
  no_referrer: 'No referrer',
  click_not_viewable: 'Clicked before the ad was viewable',
};

export const RULE_LABELS: Record<string, string> = {
  proven_bot: 'Bot found after the fact',
  click_farm: 'Click farm',
  publisher_ivt_rate: 'High IVT rate',
};

export const reasonLabel = (r: string | null | undefined) => (r ? REASON_LABELS[r] ?? r.replaceAll('_', ' ') : '');

/** "rate:180/min" keeps its number; known names get their label. */
export function signalLabel(s: string): string {
  const [name, value] = s.split(':');
  const known = SIGNAL_LABELS[name!];
  if (known) return known;
  const pretty: Record<string, string> = { rate: 'Request rate', click_fast: 'Fast click', click_burst: 'Click burst', ip_click_burst: 'Network click burst', token_age: 'Token age' };
  return value ? `${pretty[name!] ?? name} ${value}` : s.replaceAll('_', ' ');
}

export const QUALITY_TONES: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { healthy: 'success', watch: 'warning', review: 'danger', low_volume: 'neutral' };
export const QUALITY_LABELS: Record<string, string> = { healthy: 'Healthy', watch: 'Watch', review: 'Needs review', low_volume: 'Not enough traffic' };
