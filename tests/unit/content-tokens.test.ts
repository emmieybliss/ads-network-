import { describe, expect, it } from 'vitest';
import { STARTER_CONTENT, contentTokenValues, defaultSettings, fillContentTokens, missingCompanyDetails, CONTENT_TOKENS } from '@blissnova/shared';

describe('content placeholders', () => {
  it('fills company details from settings and marks the ones not supplied yet', () => {
    const s = defaultSettings();
    s.branding.companyAddress = '1 Example Street, Lagos';
    const v = contentTokenValues(s, 'http://localhost:3000');
    const out = fillContentTokens('{{companyName}}, {{companyAddress}}. Law: {{governingLaw}}. Mail {{supportEmail}}. {{unknown}}', v);
    expect(out).toBe('BlissNova Technologies, 1 Example Street, Lagos. Law: [[Governing law]]. Mail [[Support email]]. {{unknown}}');
  });

  it('uses the support email for legal and privacy requests until their own are set', () => {
    const s = defaultSettings();
    s.branding.supportEmail = 'help@blissnova.test';
    expect(fillContentTokens('{{privacyEmail}} {{legalEmail}}', contentTokenValues(s, ''))).toBe('help@blissnova.test help@blissnova.test');
    s.branding.privacyEmail = 'privacy@blissnova.test';
    expect(fillContentTokens('{{privacyEmail}}', contentTokenValues(s, ''))).toBe('privacy@blissnova.test');
  });

  it('formats platform figures', () => {
    const v = contentTokenValues(defaultSettings(), 'https://ads.blissnova.test/');
    expect(v.revenueShare).toBe('70%');
    expect(v.holdDays).toBe('30 days');
    expect(v.minimumPayout).toBe('USD 50.00');
    expect(v.payoutDay).toBe('the 21st of each month');
    expect(v.siteUrl).toBe('https://ads.blissnova.test');
  });

  it('lists missing company details for the admin checklist', () => {
    const s = defaultSettings();
    expect(missingCompanyDetails(s).map((d) => d.key)).toEqual(['companyAddress', 'companyRegistration', 'governingLaw', 'supportEmail', 'legalEmail', 'privacyEmail']);
    Object.assign(s.branding, { companyAddress: 'x', companyRegistration: 'RC 1', governingLaw: 'Nigeria', supportEmail: 'help@blissnova.test' });
    expect(missingCompanyDetails(s)).toEqual([]);
  });

  it('starter drafts use only known placeholders and unique slugs', () => {
    const keys = new Set<string>();
    for (const c of STARTER_CONTENT) {
      expect(keys.has(`${c.kind}/${c.slug}`)).toBe(false);
      keys.add(`${c.kind}/${c.slug}`);
      for (const m of `${c.title} ${c.body}`.matchAll(/\{\{\s*([a-zA-Z]+)\s*\}\}/g)) expect(Object.keys(CONTENT_TOKENS)).toContain(m[1]);
      expect(c.body.length).toBeLessThan(50_000);
    }
    for (const slug of ['terms', 'publisher-terms', 'advertiser-terms', 'privacy', 'cookies']) expect(keys.has(`legal/${slug}`)).toBe(true);
  });
});
