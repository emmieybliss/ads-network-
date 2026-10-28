import { describe, expect, it } from 'vitest';
import { explorerUrl, isValidAbaRouting, isValidCryptoAddress, isValidIban, isValidTxHash, maskedPayoutDetails, payoutDetailsSchema, payoutLabel } from '@blissnova/shared';

const issues = (v: unknown) => {
  const r = payoutDetailsSchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('bank details', () => {
  it('checks IBANs with the mod-97 rule', () => {
    expect(isValidIban('GB29 NWBK 6016 1331 9268 19')).toBe(true);
    expect(isValidIban('DE89370400440532013000')).toBe(true);
    expect(isValidIban('GB29 NWBK 6016 1331 9268 18')).toBe(false);
    expect(isValidIban('not an iban')).toBe(false);
  });

  it('checks US routing numbers', () => {
    expect(isValidAbaRouting('021000021')).toBe(true);
    expect(isValidAbaRouting('021000022')).toBe(false);
    expect(isValidAbaRouting('12345')).toBe(false);
  });

  it('needs an IBAN or an account number', () => {
    expect(issues({ method: 'bank_transfer', accountHolder: 'Ada Obi', bankName: 'GTBank', country: 'NG' })).toContain('accountNumber');
    expect(issues({ method: 'bank_transfer', accountHolder: 'Ada Obi', bankName: 'GTBank', country: 'ng', accountNumber: '0123456789', swift: 'GTBINGLA' })).toEqual([]);
  });

  it('asks US accounts for a valid routing number and UK accounts for a sort code', () => {
    expect(issues({ method: 'bank_transfer', accountHolder: 'A B', bankName: 'Chase', country: 'US', accountNumber: '000123456789', routingNumber: '021000022' })).toContain('routingNumber');
    expect(issues({ method: 'bank_transfer', accountHolder: 'A B', bankName: 'Chase', country: 'US', accountNumber: '000123456789', routingNumber: '021000021' })).toEqual([]);
    expect(issues({ method: 'bank_transfer', accountHolder: 'A B', bankName: 'Barclays', country: 'GB', accountNumber: '31926819' })).toContain('routingNumber');
  });

  it('rejects malformed SWIFT codes', () => {
    expect(issues({ method: 'bank_transfer', accountHolder: 'A B', bankName: 'X', country: 'DE', iban: 'DE89370400440532013000', swift: 'BAD' })).toContain('swift');
  });
});

describe('crypto details', () => {
  const tron = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
  const evm = '0x52908400098527886E0F7030069857D2E4169EE7';

  it('validates addresses per network', () => {
    expect(isValidCryptoAddress('tron', tron)).toBe(true);
    expect(isValidCryptoAddress('ethereum', evm)).toBe(true);
    expect(isValidCryptoAddress('ethereum', tron)).toBe(false);
    expect(isValidCryptoAddress('bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true);
    expect(isValidCryptoAddress('solana', '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV')).toBe(true);
  });

  it('refuses an asset on a network it is not paid on, and a wrong-network address', () => {
    expect(issues({ method: 'crypto', asset: 'BTC', network: 'tron', address: tron })).toContain('network');
    expect(issues({ method: 'crypto', asset: 'USDT', network: 'ethereum', address: tron })).toContain('address');
    expect(issues({ method: 'crypto', asset: 'USDT', network: 'tron', address: tron })).toEqual([]);
  });

  it('validates transaction hashes and builds explorer links only for valid ones', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    expect(isValidTxHash('polygon', hash)).toBe(true);
    expect(isValidTxHash('tron', hash)).toBe(false);
    expect(explorerUrl('polygon', hash)).toBe(`https://polygonscan.com/tx/${hash}`);
    expect(explorerUrl('polygon', 'javascript:alert(1)')).toBeNull();
  });
});

describe('labels never show the full destination', () => {
  it('masks PayPal emails, account numbers and wallet addresses', () => {
    const paypal = payoutDetailsSchema.parse({ method: 'paypal', email: 'Publisher.Name@Example.com' });
    expect(payoutLabel(paypal)).toBe('PayPal · p******@example.com');
    const bank = payoutDetailsSchema.parse({ method: 'bank_transfer', accountHolder: 'Ada Obi', bankName: 'GTBank', country: 'NG', accountNumber: '0123456789' });
    expect(payoutLabel(bank)).toBe('Bank transfer · GTBank ····6789');
    expect(JSON.stringify(maskedPayoutDetails(bank))).not.toContain('0123456789');
    const crypto = payoutDetailsSchema.parse({ method: 'crypto', asset: 'USDT', network: 'tron', address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE' });
    expect(payoutLabel(crypto)).toBe('USDT on Tron (TRC-20) · TQn9Y2…bLSE');
  });
});
