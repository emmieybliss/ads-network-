import { z } from 'zod';

/**
 * Publisher payout destinations: PayPal, bank transfer and crypto (stablecoins
 * and bitcoin). Full details are validated here, encrypted at rest by the API,
 * and only ever shown back to the publisher in masked form.
 */
export const PAYOUT_METHODS = ['paypal', 'bank_transfer', 'crypto'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export const CRYPTO_NETWORKS = {
  tron: { label: 'Tron (TRC-20)', address: 'tron', tx: 'hex64', explorer: 'https://tronscan.org/#/transaction/' },
  ethereum: { label: 'Ethereum (ERC-20)', address: 'evm', tx: 'evm', explorer: 'https://etherscan.io/tx/' },
  bsc: { label: 'BNB Smart Chain (BEP-20)', address: 'evm', tx: 'evm', explorer: 'https://bscscan.com/tx/' },
  polygon: { label: 'Polygon', address: 'evm', tx: 'evm', explorer: 'https://polygonscan.com/tx/' },
  base: { label: 'Base', address: 'evm', tx: 'evm', explorer: 'https://basescan.org/tx/' },
  solana: { label: 'Solana', address: 'solana', tx: 'solana', explorer: 'https://solscan.io/tx/' },
  bitcoin: { label: 'Bitcoin', address: 'bitcoin', tx: 'hex64', explorer: 'https://mempool.space/tx/' },
} as const;
export type CryptoNetwork = keyof typeof CRYPTO_NETWORKS;

/** Which networks each asset can be paid on. */
export const CRYPTO_ASSETS = {
  USDT: ['tron', 'ethereum', 'bsc', 'polygon', 'solana'],
  USDC: ['ethereum', 'polygon', 'base', 'solana'],
  BTC: ['bitcoin'],
} as const satisfies Record<string, readonly CryptoNetwork[]>;
export type CryptoAsset = keyof typeof CRYPTO_ASSETS;

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
const ADDRESS: Record<string, RegExp> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  tron: new RegExp(`^T${BASE58}{33}$`),
  solana: new RegExp(`^${BASE58}{32,44}$`),
  bitcoin: new RegExp(`^(bc1[ac-hj-np-z02-9]{11,71}|[13]${BASE58}{25,34})$`),
};
const TX_HASH: Record<string, RegExp> = {
  evm: /^0x[0-9a-fA-F]{64}$/,
  hex64: /^[0-9a-fA-F]{64}$/,
  solana: new RegExp(`^${BASE58}{64,90}$`),
};

export function isValidCryptoAddress(network: CryptoNetwork, address: string): boolean {
  return ADDRESS[CRYPTO_NETWORKS[network].address]!.test(address);
}

export function isValidTxHash(network: CryptoNetwork, hash: string): boolean {
  return TX_HASH[CRYPTO_NETWORKS[network].tx]!.test(hash);
}

export function explorerUrl(network: CryptoNetwork, hash: string): string | null {
  return isValidTxHash(network, hash) ? `${CRYPTO_NETWORKS[network].explorer}${hash}` : null;
}

/** ISO 13616 IBAN check (mod 97). */
export function isValidIban(raw: string): boolean {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** US ABA routing number checksum. */
export function isValidAbaRouting(raw: string): boolean {
  if (!/^\d{9}$/.test(raw)) return false;
  const d = [...raw].map(Number);
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

export const SWIFT_RE = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
const compact = (v: string) => v.replace(/[\s-]+/g, '').toUpperCase();

export const paypalDetailsSchema = z.object({
  method: z.literal('paypal'),
  email: z.email().trim().toLowerCase().max(254),
});

export const bankDetailsSchema = z.object({
  method: z.literal('bank_transfer'),
  accountHolder: trimmed(2, 120),
  bankName: trimmed(2, 120),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use the two-letter country code, for example NG or GB'),
  iban: z.string().transform(compact).optional().or(z.literal('').transform(() => undefined)),
  accountNumber: z.string().transform((v) => v.replace(/[\s-]+/g, '')).optional().or(z.literal('').transform(() => undefined)),
  /** US ABA routing number, UK sort code, or the local bank/branch code. */
  routingNumber: z.string().transform((v) => v.replace(/[\s-]+/g, '')).optional().or(z.literal('').transform(() => undefined)),
  swift: z.string().transform(compact).optional().or(z.literal('').transform(() => undefined)),
}).superRefine((b, ctx) => {
  if (!b.iban && !b.accountNumber) ctx.addIssue({ code: 'custom', path: ['accountNumber'], message: 'Enter an IBAN or an account number' });
  if (b.iban && !isValidIban(b.iban)) ctx.addIssue({ code: 'custom', path: ['iban'], message: 'That IBAN is not valid. Check it against your bank statement.' });
  if (b.accountNumber && !/^[A-Za-z0-9]{4,34}$/.test(b.accountNumber)) ctx.addIssue({ code: 'custom', path: ['accountNumber'], message: 'Account numbers are 4 to 34 letters or digits' });
  if (b.country === 'US' && !b.iban && !(b.routingNumber && isValidAbaRouting(b.routingNumber))) ctx.addIssue({ code: 'custom', path: ['routingNumber'], message: 'Enter a valid 9-digit ABA routing number' });
  if (b.country === 'GB' && !b.iban && !(b.routingNumber && /^\d{6}$/.test(b.routingNumber))) ctx.addIssue({ code: 'custom', path: ['routingNumber'], message: 'Enter your 6-digit sort code' });
  if (b.routingNumber && !/^[A-Za-z0-9]{3,20}$/.test(b.routingNumber)) ctx.addIssue({ code: 'custom', path: ['routingNumber'], message: 'Bank codes are 3 to 20 letters or digits' });
  if (b.swift && !SWIFT_RE.test(b.swift)) ctx.addIssue({ code: 'custom', path: ['swift'], message: 'SWIFT/BIC codes are 8 or 11 characters, for example GTBINGLA' });
});

export const cryptoDetailsSchema = z.object({
  method: z.literal('crypto'),
  asset: z.enum(Object.keys(CRYPTO_ASSETS) as [CryptoAsset, ...CryptoAsset[]]),
  network: z.enum(Object.keys(CRYPTO_NETWORKS) as [CryptoNetwork, ...CryptoNetwork[]]),
  address: z.string().trim().min(20).max(100),
  /** Some exchanges need a memo/tag to credit the right account. */
  memo: z.string().trim().max(64).optional().or(z.literal('').transform(() => undefined)),
}).superRefine((c, ctx) => {
  if (!(CRYPTO_ASSETS[c.asset] as readonly string[]).includes(c.network)) ctx.addIssue({ code: 'custom', path: ['network'], message: `${c.asset} is not paid on ${CRYPTO_NETWORKS[c.network].label}` });
  else if (!isValidCryptoAddress(c.network, c.address)) ctx.addIssue({ code: 'custom', path: ['address'], message: `That is not a valid ${CRYPTO_NETWORKS[c.network].label} address` });
});

export const payoutDetailsSchema = z.discriminatedUnion('method', [paypalDetailsSchema, bankDetailsSchema, cryptoDetailsSchema]);
export type PayoutDetails = z.infer<typeof payoutDetailsSchema>;

function maskTail(v: string, keep = 4) {
  return `····${v.slice(-keep)}`;
}

export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(user.length - 1, 6)))}@${domain}`;
}

export function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** A label safe to show anywhere (lists, emails, CSV exports): never the full account. */
export function payoutLabel(d: PayoutDetails): string {
  switch (d.method) {
    case 'paypal':
      return `PayPal · ${maskEmail(d.email)}`;
    case 'bank_transfer':
      return `Bank transfer · ${d.bankName} ${maskTail(d.iban ?? d.accountNumber ?? '')}`;
    case 'crypto':
      return `${d.asset} on ${CRYPTO_NETWORKS[d.network].label} · ${shortAddress(d.address)}`;
  }
}

/** Masked fields for the publisher's own view of their saved method. */
export function maskedPayoutDetails(d: PayoutDetails): Record<string, string> {
  switch (d.method) {
    case 'paypal':
      return { email: maskEmail(d.email) };
    case 'bank_transfer':
      return {
        accountHolder: d.accountHolder, bankName: d.bankName, country: d.country,
        ...(d.iban ? { iban: `${d.iban.slice(0, 4)} ${maskTail(d.iban)}` } : {}),
        ...(d.accountNumber ? { accountNumber: maskTail(d.accountNumber) } : {}),
        ...(d.swift ? { swift: d.swift } : {}),
      };
    case 'crypto':
      return { asset: d.asset, network: CRYPTO_NETWORKS[d.network].label, address: shortAddress(d.address), ...(d.memo ? { memo: 'set' } : {}) };
  }
}
