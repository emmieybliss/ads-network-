import { describe, expect, it } from 'vitest';
import { decideConsent, decodeTcString, decodeUsNat, gppSectionIds, uspOptedOut } from '@blissnova/api/services/consent';
import { gppString, tcString, usNat } from '../helpers/consent';

const on = { personalizedAllowed: true, vendorId: 1234, secGpc: false };

describe('TCF v2 TC strings', () => {
  it('decodes a published example string', () => {
    const t = decodeTcString('CPXxRfAPXxRfAAfKABENB-CgAAAAAAAAAAYgAAAAAAAA');
    expect(t?.version).toBe(2);
    expect(t?.cmpId).toBe(31);
  });

  it('reads purpose and vendor consents in bitfield and range form', () => {
    for (const ranges of [false, true]) {
      const t = decodeTcString(tcString({ purposes: [1, 3, 4], vendors: [7, 1234], ranges }))!;
      expect(t.policyVersion).toBe(4);
      expect(t.purposeConsents.slice(0, 4)).toEqual([true, false, true, true]);
      expect(t.vendorConsent(1234)).toBe(true);
      expect(t.vendorConsent(8)).toBe(false);
    }
  });

  it('rejects anything that is not a v2 TC string', () => {
    expect(decodeTcString('')).toBeNull();
    expect(decodeTcString('not a tc string!')).toBeNull();
    expect(decodeTcString(tcString({ purposes: [1], vendors: [1], version: 1 }))).toBeNull();
    expect(decodeTcString('CPXx')).toBeNull();
  });
});

describe('GPP strings', () => {
  it('reads section ids from published example headers', () => {
    expect(gppSectionIds('DBABMA')).toEqual([2]);
    expect(gppSectionIds('DBACNYA')).toEqual([2, 6]);
    expect(gppSectionIds('DBABLA')).toEqual([7]);
  });

  it('round-trips our encoder, including large ids', () => {
    expect(gppSectionIds(gppString([{ id: 2, body: 'x' }, { id: 7, body: 'y' }, { id: 12, body: 'z' }]).split('~')[0]!)).toEqual([2, 7, 12]);
  });

  it('decodes usnat opt-outs and the GPC sub-section', () => {
    expect(decodeUsNat(usNat({}))).toEqual({ optedOut: false, gpc: false });
    expect(decodeUsNat(usNat({ targeted: 1 }))?.optedOut).toBe(true);
    expect(decodeUsNat(usNat({ sale: 1 }))?.optedOut).toBe(true);
    expect(decodeUsNat(usNat({ gpc: true }))?.gpc).toBe(true);
  });

  it('reads US Privacy strings', () => {
    expect(uspOptedOut('1YYN')).toBe(true);
    expect(uspOptedOut('1YNN')).toBe(false);
    expect(uspOptedOut('1---')).toBe(false);
    expect(uspOptedOut('junk')).toBeNull();
  });
});

describe('consent decision', () => {
  const yes = tcString({ purposes: [1, 2, 3, 4, 7], vendors: [1234] });

  it('is contextual when the network has personalization off', () => {
    expect(decideConsent({ personalized: true }, { ...on, personalizedAllowed: false })).toEqual({ personalized: false, reason: 'network_off' });
  });

  it('uses the publisher setting where GDPR does not apply', () => {
    expect(decideConsent({ personalized: true }, on).personalized).toBe(true);
    expect(decideConsent({}, on).reason).toBe('no_consent');
    expect(decideConsent(undefined, on).reason).toBe('no_consent');
  });

  it('needs vendor consent and purposes 1, 3 and 4 under GDPR', () => {
    expect(decideConsent({ gdprApplies: true, tcString: yes }, on)).toEqual({ personalized: true, reason: 'allowed' });
    expect(decideConsent({ gdprApplies: true, tcString: tcString({ purposes: [1, 3], vendors: [1234] }) }, on).reason).toBe('tcf_denied');
    expect(decideConsent({ gdprApplies: true, tcString: tcString({ purposes: [1, 3, 4], vendors: [99] }) }, on).reason).toBe('tcf_denied');
  });

  it('ignores a publisher "yes" when GDPR applies without a valid TC string', () => {
    expect(decideConsent({ gdprApplies: true, personalized: true }, on).reason).toBe('tcf_missing');
    expect(decideConsent({ gdprApplies: true, personalized: true, tcString: 'garbage' }, on).reason).toBe('tcf_invalid');
  });

  it('never claims TCF consent without a registered vendor id', () => {
    expect(decideConsent({ gdprApplies: true, tcString: yes }, { ...on, vendorId: undefined }).reason).toBe('tcf_no_vendor_id');
    expect(decideConsent({ gdprApplies: true, tcString: tcString({ purposes: [], vendors: [] }) }, { ...on, vendorId: undefined }).reason).toBe('tcf_denied');
  });

  it('lets the publisher turn personalization off whatever the CMP says', () => {
    expect(decideConsent({ gdprApplies: true, tcString: yes, personalized: false }, on).reason).toBe('no_consent');
  });

  it('honours Global Privacy Control from the header or the page', () => {
    expect(decideConsent({ personalized: true }, { ...on, secGpc: true }).reason).toBe('gpc');
    expect(decideConsent({ personalized: true, gpc: true }, on).reason).toBe('gpc');
  });

  it('honours US opt-outs from GPP and US Privacy', () => {
    expect(decideConsent({ personalized: true, gpp: gppString([{ id: 7, body: usNat({ targeted: 1 }) }]), gppSections: [7] }, on).reason).toBe('gpp_opt_out');
    expect(decideConsent({ personalized: true, gpp: gppString([{ id: 7, body: usNat({ gpc: true }) }]), gppSections: [7] }, on).reason).toBe('gpc');
    expect(decideConsent({ personalized: true, gpp: gppString([{ id: 7, body: usNat({}) }]), gppSections: [7] }, on).personalized).toBe(true);
    expect(decideConsent({ personalized: true, gpp: gppString([{ id: 6, body: '1YYN' }]) }, on).reason).toBe('usp_opt_out');
    expect(decideConsent({ personalized: true, usp: '1YYN' }, on).reason).toBe('usp_opt_out');
  });

  it('treats sections it cannot read yet as an opt-out, and skips ones that do not apply', () => {
    const ca = gppString([{ id: 8, body: 'BAAAAAAA' }]);
    expect(decideConsent({ personalized: true, gpp: ca, gppSections: [8] }, on).reason).toBe('gpp_unsupported');
    expect(decideConsent({ personalized: true, gpp: ca, gppSections: [-1] }, on).personalized).toBe(true);
    expect(decideConsent({ personalized: true, gpp: 'nonsense~x' }, on).reason).toBe('gpp_invalid');
  });

  it('reads a TC string carried inside GPP', () => {
    expect(decideConsent({ gpp: gppString([{ id: 2, body: yes }]), gppSections: [2] }, on)).toEqual({ personalized: true, reason: 'allowed' });
  });
});
