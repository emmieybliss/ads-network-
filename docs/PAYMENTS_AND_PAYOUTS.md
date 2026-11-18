# Payments and payouts

How money comes in from advertisers and goes out to publishers, what works
without any accounts, and exactly what you need to go live.

## What works today, with no accounts

| Flow | Local demo | Needs to go live |
| --- | --- | --- |
| Advertiser deposit by card | Simulated checkout (`ENABLE_DEV_PAYMENTS=true`) | Paystack account (Nigeria-registered business), or a Stripe account |
| Advertiser deposit by PayPal | Simulated checkout | PayPal business account |
| Advertiser deposit by bank transfer | Works (finance confirms receipt) | Nothing |
| Refund to card / PayPal | Recorded only for simulated payments | Same Paystack / Stripe / PayPal accounts |
| Publisher payout by PayPal | Simulated send + signed webhook | PayPal business account with **Payouts** enabled |
| Publisher payout by bank transfer | Works: staff pay from your bank, record the reference | Nothing (a bank account to pay from) |
| Publisher payout by crypto (USDT, USDC, BTC) | Works: staff pay from your wallet, record the transaction hash | Nothing (a funded wallet) |
| Monthly automatic payout requests | Works (default day 21, Settings → Publishers) | Nothing |

The simulated provider is refused in production: startup fails if
`ENABLE_DEV_PAYMENTS=true` while `NODE_ENV=production`.

## Publisher payouts

1. The publisher saves a payout method on **Earnings & payouts**: PayPal email,
   bank account (IBAN, or account number plus routing number / sort code /
   bank code, optional SWIFT) or a crypto wallet (asset + network + address).
   Details are validated (IBAN check digits, US routing checksum, address
   format per network), encrypted at rest with `ENCRYPTION_KEY`, and shown
   back only masked. Every change is emailed to the account owners.
2. The publisher requests a payout, or opts in to a monthly request.
3. Finance approves it (step-up password, never the person who requested it).
   Approval moves the amount from *available* into *payout in progress*.
4. Finance sends it:
   - **PayPal**: *Send with PayPal* calls the PayPal Payouts API. The payout
     id is the PayPal request id, so a retry can never pay twice. It is
     marked paid or failed from PayPal's verified webhook, or by the
     five-minute status check if a webhook is missed.
   - **Bank / crypto**: *Pay manually* shows the full details (audited),
     staff send the money, then record the bank reference or the transaction
     hash (checked against the network's format; the publisher gets a block
     explorer link). The *Approved … payouts (CSV)* buttons export every
     approved payout for a bulk bank upload or wallet batch.
5. A failed payout returns the money to the publisher's available balance.

A payout keeps the destination it was requested with. Changing details
afterwards cannot redirect it, and the admin list flags payouts whose details
changed within a week of the request.

## Going live: what you need

**Which card provider?** Stripe does not open accounts for businesses
registered in Nigeria. A Nigerian company should use **Paystack** (owned by
Stripe), which takes cards, bank transfer and USSD in NGN, and in USD once
Paystack approves USD for the business. Stripe is only an option if the
business also has a company in a country Stripe supports (for example a US
LLC). Both can be switched on at once; advertisers then pick one.

### Paystack (card, bank transfer and USSD deposits, and refunds)

1. Create a Paystack business account and complete the compliance (CAC
   registration, director ID, settlement bank account). To take USD, ask
   Paystack to enable USD on the account.
2. Settings → API Keys & Webhooks: copy the **secret key** (`sk_test_…`
   while testing, `sk_live_…` for production).
3. On the same page, set the **Live Webhook URL** (and Test Webhook URL) to
   `<PUBLIC_API_URL>/api/v1/webhooks/payments/paystack`. Paystack signs each
   delivery with your secret key, so there is no separate webhook secret.
4. Set `PAYSTACK_SECRET_KEY`, and `PAYSTACK_CURRENCIES` to the currencies the
   account is enabled for (default `NGN,USD`). Paystack only appears for
   advertisers whose billing currency is in that list.

How it works: the deposit starts a Paystack checkout with our payment id as
the Paystack reference. The balance is credited when Paystack's signed
`charge.success` webhook arrives, or when the advertiser comes back and
Paystack's Verify Transaction API says the payment succeeded (the reconcile
job also checks pending ones every few minutes). Either way the amount and
currency must match exactly, and a payment is never credited twice.

**Test mode run (once you have a test key):** copy `payment-keys.env.example` to
`payment-keys.env` in the project folder, fill in `PAYSTACK_SECRET_KEY=sk_test_…`,
restart the demo, sign in as the advertiser and make a deposit, and pay with Paystack's test card
`4084 0840 8408 4081`, any future expiry, CVV `408`. With no public URL the
webhook cannot reach your PC, but coming back to the billing page verifies
the payment through Paystack's API and credits it.

### Stripe (card deposits and card refunds)

1. Create a Stripe account and complete business verification.
2. Developers → API keys: copy the **secret key** (`sk_live_…`, or a
   restricted key `rk_live_…` with Checkout Sessions and Refunds write access).
3. Developers → Webhooks → Add endpoint:
   `<PUBLIC_API_URL>/api/v1/webhooks/payments/stripe`, events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `charge.dispute.created`.
   Copy the **signing secret** (`whsec_…`).
4. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.

To try it first, use `sk_test_…` keys and Stripe's test cards. Production
startup refuses test keys.

**Test mode run on your PC:** install the Stripe CLI, run
`stripe login`, then
`stripe listen --forward-to localhost:4000/api/v1/webhooks/payments/stripe`.
It prints a `whsec_…` secret. Put `STRIPE_SECRET_KEY=sk_test_…` and that
`STRIPE_WEBHOOK_SECRET` in `payment-keys.env` (copied from
`payment-keys.env.example`), restart the demo, deposit with card
`4242 4242 4242 4242`, and watch the balance update.

**Automated check without an account:** `tests/integration/stripe-mock.test.ts`
runs the whole card flow (checkout, webhook, replay, refund, dispute)
against [stripe-mock](https://github.com/stripe/stripe-mock), which answers
with Stripe's real API schema and rejects any parameter Stripe would reject.
Run `stripe-mock -http-port 12111`, then
`STRIPE_MOCK_URL=http://localhost:12111 pnpm vitest run tests/integration/stripe-mock.test.ts`.

### Chargebacks (Paystack and Stripe)

When a card holder disputes a payment, the provider's dispute webhook
(`charge.dispute.created` / `charge.dispute.create`) creates a critical
security event and notifies finance staff by email and in the dashboard.
The advertiser's balance is not changed automatically: respond in the
provider's dashboard before its deadline, then refund or adjust here if you
lose the dispute.

### PayPal (PayPal deposits, PayPal payouts, refunds)

1. A PayPal **business** account. For payouts, ask PayPal to enable
   **Payouts** on it (it is not on by default) and keep a balance to pay from.
2. developer.paypal.com → Apps & Credentials → create a REST app: copy the
   **client id** and **secret** (Sandbox while testing, Live for production).
3. In the app, add a webhook: `<PUBLIC_API_URL>/api/v1/webhooks/paypal` with
   events `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`,
   `PAYMENT.CAPTURE.DECLINED` and all `PAYMENT.PAYOUTS-ITEM.*`. Copy the
   **webhook id**.
4. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` and
   `PAYPAL_ENV=live` (`sandbox` while testing; production refuses sandbox).

PayPal now works in Nigeria through its partnership with Paga (since
January 2026), but check with PayPal that your business account can receive
payments and use Payouts before relying on it.

PayPal does not support NGN; for organizations billed in NGN the PayPal
option is hidden and card or bank transfer is used.

### Bank and crypto payouts

No API account is needed: staff pay from your own bank account or wallet and
record the reference. Automating these (for example Wise for bank transfers,
or an exchange/custody API for stablecoins) needs an account with that
provider and can be added as another payout provider later.

### Before switching on

- Run **Admin → Finance → Providers → Test connection** for each provider.
- Make one small real deposit and one small real payout end to end.
- Both webhook URLs need your public HTTPS API address, so this waits until
  the platform has a domain and hosting.
