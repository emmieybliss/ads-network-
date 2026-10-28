# Payments and payouts

How money comes in from advertisers and goes out to publishers, what works
without any accounts, and exactly what you need to go live.

## What works today, with no accounts

| Flow | Local demo | Needs to go live |
| --- | --- | --- |
| Advertiser deposit by card | Simulated checkout (`ENABLE_DEV_PAYMENTS=true`) | Stripe account |
| Advertiser deposit by PayPal | Simulated checkout | PayPal business account |
| Advertiser deposit by bank transfer | Works (finance confirms receipt) | Nothing |
| Refund to card / PayPal | Recorded only for simulated payments | Same Stripe / PayPal accounts |
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

### Stripe (card deposits and card refunds)

1. Create a Stripe account and complete business verification.
2. Developers → API keys: copy the **secret key** (`sk_live_…`, or a
   restricted key `rk_live_…` with Checkout Sessions and Refunds write access).
3. Developers → Webhooks → Add endpoint:
   `<PUBLIC_API_URL>/api/v1/webhooks/payments/stripe`, events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`.
   Copy the **signing secret** (`whsec_…`).
4. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.

To try it first, use `sk_test_…` keys and Stripe's test cards. Production
startup refuses test keys.

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
