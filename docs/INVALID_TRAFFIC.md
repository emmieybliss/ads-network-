# Invalid traffic (IVT)

How BlissNova decides which impressions and clicks are real, what happens to
the rest, and what staff and publishers see. Everything here runs inside the
platform: no paid outside service is used.

## On every event (real time)

Each render, viewable and click goes through `assessEvent`
(`packages/tracking/src/ivt.ts`). Hard checks make an event invalid on their
own; soft signals add to a score, and the event is invalid when the score
reaches **Settings → Invalid traffic → Score threshold** (60 by default).

| Check | Kind | Reason shown |
| --- | --- | --- |
| Forged, damaged or expired tracking token; replayed or duplicate event | hard | `token_invalid`, `token_expired`, `replay`, `duplicate` |
| Shown on a domain the site does not own; site or account not approved | hard | `domain_mismatch`, `site_inactive` |
| Bot or crawler user agent (incl. HeadlessChrome, curl, Puppeteer) | hard | `crawler` |
| **Request from a cloud or hosting network** | hard | `datacenter` |
| **Automated browser**: `navigator.webdriver`, automation-tool globals, a click dispatched by script | hard | `automation` |
| **Clicks on a machine-regular rhythm** (5+ clicks from one visitor with near-identical gaps) | hard | `click_pattern` |
| Click or view without a counted impression | hard | `sequence` |
| Too many requests from one network per minute | soft | `rate_anomaly` |
| Click sooner than the minimum after the ad appeared | soft | `click_too_fast` |
| Too many clicks per visitor, or **per network**, per hour | soft | `click_burst` |
| **Weak automation signs**: headless window, Chrome without `window.chrome`, no screen, no languages, no mouse movement before a mouse click, no `Accept-Language`, missing `Sec-Fetch-*` headers on browsers that always send them | soft | `automation` (when they dominate) |
| **Click on an ad that never became viewable**, missing referrer, token used within 50 ms | soft | `anomaly_score` |

Each stored event keeps `ivt_signals` (what it tripped, e.g. `webdriver`,
`rate:180/min`) and `client_flags` (the ad tag's bitmask) for investigation.
The raw IP is checked at the edge and never stored; only its keyed hash is.

### Cloud and hosting networks

`packages/tracking/src/datacenter-ranges.generated.ts` holds ranges the
providers publish themselves. Refresh it with:

```
node scripts/update-datacenter-ranges.mjs
```

It loads Amazon Web Services, Google Cloud, Oracle Cloud, DigitalOcean and
Linode, skips any it cannot reach, and needs at least one. The copy in the
repository was generated on 2026-11-11 from **Amazon's list only**, because the
build machine could not reach the others; running the script on a normal
internet connection adds them. Microsoft Azure publishes its list behind a
weekly-changing download link, so add Azure ranges you care about under
**Extra data-center ranges**.

Staff settings:

- **Extra data-center ranges**: more CIDR ranges to treat as servers.
- **Trusted ranges**: never treated as servers (e.g. an office VPN that exits in a cloud).
- **Treat cloud and hosting networks as invalid**: switch the check off entirely.

Corporate VPNs and some privacy relays exit from cloud networks, so a small
share of real people is filtered too. That is the industry norm (MRC lists
known data-center traffic as General IVT) and is the right trade for
advertiser trust; use trusted ranges for known exceptions.

## The sweep (every five minutes)

`runIvtSweep` (`apps/api/src/services/ivt.ts`) looks at the last 24 hours for
what single events cannot show:

1. **Bot found after the fact.** A visitor (or a data-center IP) that tripped a
   definite check taints its other events that were counted as valid.
2. **Click farm.** A visitor with more valid clicks in a day than
   *Clicks per visitor per day before clawback* (20).
3. **High publisher IVT rate.** A publisher whose 7-day invalid rate is at or
   above *Review a publisher at this IVT %* (25%) with at least the minimum
   impressions gets a review case (one per week). Its proposed action removes
   the traffic that passed but scored 30 or more.

With **Claw back held earnings automatically** on (the default), rules 1 and 2
exclude the events at once: the advertiser's spend is returned and the
publisher's earnings are reversed, **but only while those earnings are still
on hold** (the earnings hold period, 30 days by default). The publisher gets a
notification and a confirmed case they can appeal once. Events whose earnings
were already released are never touched automatically: they go to the review
queue instead.

With automatic clawback off, every finding becomes a review case with the
proposed exclusion attached.

## Staff: Admin → Invalid traffic

- **Summary**: network IVT rate, review queue size, automatic clawbacks, which checks are on.
- **Review queue**: open, investigating and appealed cases, most severe first, with the earnings each proposal would reverse. *Claw back* (needs step-up) applies the proposal and confirms the case; *Dismiss* records why the traffic is acceptable.
- **Publishers**: IVT rate per publisher, trend against the previous 7 days, invalid click rate, main reason, amount clawed back, status (Healthy, Watch at half the review rate, Needs review).
- **Clawbacks**: every exclusion, automatic or by staff, with the advertiser refund and the publisher amount. *Run the sweep now* runs it on demand.
- **Events**: each event's score and signals.

An upheld appeal closes the case; it does not restore the excluded events.
Pay back earnings for an upheld appeal with a manual ledger adjustment under
Finance.

## Publishers: Policy & traffic quality

Their 30-day invalid rate and status, a daily chart, why traffic was filtered
(plain-language reasons), earnings removed and by whom (automatic check or
review team), and their cases with the appeal button.

## Limits

- Client checks can be faked by a determined fraudster; they stop cheap
  automation. Sophisticated IVT (residential proxies, real-device farms) needs
  an accredited vendor and is out of scope.
- Visitor-level rules (bot after the fact, click farm) need a visitor id,
  which only exists with personalization consent. Without it, the IP hash is
  used only for data-center traffic.
