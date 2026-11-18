/**
 * Starter drafts for the public legal pages, policies and FAQ.
 *
 * These are written for this platform (they describe what the code actually
 * does: hashed IPs, consent-gated personalization, the hold period, review of
 * every site and creative) and are modelled on the structure of established
 * networks' terms and program policies. They are drafts: the operator must
 * have them reviewed by a qualified lawyer for their own jurisdiction before
 * launch. Company details and numbers are {{tokens}} filled from Settings, so
 * they stay in step with the platform's configuration.
 *
 * Body format: blank lines between paragraphs, "# " for a heading, "## " for a
 * sub-heading and "- " for a list item.
 */
export interface StarterContent {
  kind: 'faq' | 'advertiser_policy' | 'publisher_policy' | 'creative_rules' | 'legal';
  slug: string;
  title: string;
  body: string;
  sortOrder: number;
}

/** Bump when the drafts change in a way existing installations should be offered. */
export const STARTER_CONTENT_VERSION = '2026-11';

/**
 * Bodies written by earlier seed scripts. An item still holding one of these
 * exactly (nobody edited it) is replaced by the new draft on upgrade.
 */
export const LEGACY_SEED_BODIES: readonly string[] = [
  'Placeholder. The platform operator must supply their own terms of service, reviewed by a qualified professional, before launch.',
  'Placeholder. The platform operator must supply their own privacy policy, reviewed by a qualified professional, before launch.',
  'A multi-publisher advertising network: advertisers run campaigns, publishers place ad units on their sites, and the platform handles delivery, measurement and payouts.',
  'Every delivery is recorded, then filtered for invalid traffic. Only valid events are reported and billed. Click-through rate is valid clicks divided by valid impressions, multiplied by 100.',
  'Earnings move from pending to available after the platform hold period, then can be requested as a payout. Payout methods and schedules are configured by the platform operator.',
  'Advertisers need a funded account balance and at least one approved creative. Publishers need a verified and approved site and a placement, then paste the JavaScript ad tag into any page; no plugin is needed.',
];

const TERMS = `These Terms of Service ("Terms") are an agreement between you and {{companyName}} ("we", "us"), a company registered under number {{companyRegistration}} with its registered office at {{companyAddress}}. They govern your use of {{productName}} (the "Network"), including the website at {{siteUrl}}, the dashboards, the ad tag, the API and any related services.

If you use the Network for a business, you accept these Terms on its behalf and confirm that you have authority to do so. Publishers also accept the Publisher Terms and the Publisher Policies; advertisers also accept the Advertiser Terms and the Advertiser Policies. Where those documents conflict with these Terms, they take precedence for their subject.

# 1. Accounts

You must be at least 18 years old and able to enter a binding contract. Give us accurate information when you register and keep it up to date, including your legal name, contact details, and payment and tax details.

You are responsible for everything done through your account and your API keys. Keep your password and keys confidential, use two-step verification where it is offered, and tell us at once at {{supportEmail}} if you suspect unauthorised access.

An organisation may invite team members. The organisation is responsible for the actions of everyone it invites and for removing access when it is no longer needed.

# 2. Using the Network

You may use the Network only for its intended purpose and in line with applicable law and our policies. You must not:

- interfere with, overload or try to break the Network, its security or its measurement;
- generate, buy or knowingly accept invalid traffic, including automated, incentivised or misleading impressions and clicks;
- copy, reverse engineer or resell the Network, except where the law allows this despite this restriction;
- access the Network with automated means other than the published API, or exceed published rate limits;
- use the Network to collect personal data about visitors beyond what the Network itself is designed to collect.

# 3. Review and approval

Every publisher site, campaign and creative is reviewed before it serves, and may be reviewed again at any time. We may approve, reject, limit or remove any site, placement, campaign or creative at our discretion, including to protect visitors, advertisers, publishers or the Network.

# 4. Measurement

Impressions, clicks, viewability and other metrics are counted by the Network's own measurement. We filter invalid traffic before reporting and billing, and we may adjust figures afterwards when invalid activity is found later. Our measurement is final for billing and payments unless we agree otherwise in writing.

# 5. Fees and payments

Advertisers pay for valid delivery as described in the Advertiser Terms. Publishers are paid a share of revenue from valid delivery as described in the Publisher Terms. Amounts are in the currency shown in your account. You are responsible for your own taxes.

# 6. Content and intellectual property

You keep ownership of the content you provide, such as creatives, site content and brand assets. You give us a worldwide, non-exclusive, royalty-free licence to host, copy, process, display and transmit that content as needed to run, measure and improve the Network and to show your use of it to the other party in a transaction (for example, a creative to the publisher whose site displayed it).

We own the Network, its software and its documentation. These Terms do not give you any right to our trademarks except as we expressly allow.

# 7. Privacy and data protection

Our Privacy Policy explains how we handle personal data. Where we process visitor data on behalf of publishers or advertisers, each party is responsible for its own obligations under data protection law, including giving notices and obtaining any consent required on their own websites. Publishers must display a privacy policy that discloses the use of third-party advertising.

# 8. Confidentiality

Non-public information about the Network, including pricing not shown publicly, report data about other parties, and anything marked confidential, must be kept confidential and used only for your use of the Network.

# 9. Suspension and termination

You may close your account at any time from your account settings or by writing to {{supportEmail}}. We may suspend or close an account, or withhold amounts as described in the role-specific terms, if you breach these Terms or our policies, if required by law, or if your use creates risk for others. Sections that by their nature should survive termination, including payment obligations, confidentiality, liability limits and governing law, survive it.

# 10. Disclaimers

The Network is provided "as is" and "as available". We work to keep it reliable and secure, but we do not promise that it will be uninterrupted or error-free, or that any campaign will reach a particular result or that any site will earn a particular amount.

# 11. Limitation of liability

To the extent the law allows, neither party is liable to the other for indirect, incidental, special or consequential losses, or for lost profits, revenue or data, arising from these Terms. Our total liability arising from these Terms in any 12-month period is limited to the fees you paid us, or the amounts we paid you, in that period. Nothing in these Terms limits liability that cannot be limited by law, including for fraud or for death or personal injury caused by negligence.

# 12. Indemnity

You will defend and indemnify us against claims by third parties arising from your content, your websites, your landing pages or your breach of these Terms or the law.

# 13. Changes

We may update these Terms. We will tell you about material changes by email or in your dashboard at least 30 days before they take effect, unless a change is required sooner by law or to prevent abuse. Continuing to use the Network after a change takes effect means you accept it.

# 14. Governing law

These Terms are governed by the laws of {{governingLaw}}, and the courts there have exclusive jurisdiction, except where mandatory law where you live says otherwise.

# 15. Contact

Questions about these Terms: {{legalEmail}}. General support: {{supportEmail}}. Post: {{companyName}}, {{companyAddress}}.`;

const PUBLISHER_TERMS = `These Publisher Terms add to our Terms of Service and apply when you use {{productName}} to show ads on websites you own or control. You must also follow the Publisher Policies.

# 1. Sites and approval

Add each website to your account and prove that you control it using one of the offered verification methods. A site may show ads only after we approve it, and only on the domains approved for it. You must keep the site in line with the Publisher Policies for as long as it shows ads.

# 2. The ad tag

You place ads by adding our ad tag to your pages. You must not change the tag's code, hide or cover its "Sponsored" label, place it inside frames or pop-ups we have not approved, or interfere with how it measures ads. You can remove the tag at any time.

# 3. Revenue share

You earn a share of the revenue we receive from advertisers for valid ad delivery on your approved sites. The default share is {{revenueShare}} unless your account shows a different agreed share. Earnings are calculated from our measurement after invalid traffic is removed.

# 4. Hold period, invalid traffic and adjustments

New earnings are held for {{holdDays}} before they become available, so that invalid activity can be detected. We may reduce or withhold earnings, before or after they become available, that come from invalid traffic, from a breach of these terms or the policies, or that an advertiser does not pay for because of such activity. If we find serious or repeated invalid traffic we may close the account and withhold unpaid earnings.

# 5. Payouts

You can request a payout once your available balance reaches {{minimumPayout}}. If you turn on automatic payouts, a request is raised for you on {{payoutDay}}. Every payout is reviewed before it is sent. You must provide accurate payout and tax information; fees charged by your bank or payment provider are yours. Balances below the minimum carry over.

If a payout cannot be delivered because of incorrect details, we will contact you; we may need to verify your identity before paying. Unclaimed balances are handled as the law requires.

# 6. Your obligations

You are responsible for your sites, their content and their compliance with law, including privacy and consent law for your visitors. Your privacy policy must explain that third parties, including {{companyName}}, may show ads and use visitor data on your site, and how visitors can make choices. Where the law requires consent, you must use a consent management platform and pass consent signals to the tag.

# 7. Termination

Either party may end these Publisher Terms at any time. When they end you must remove the ad tag. We will pay available earnings that are not subject to withholding under section 4, once they reach the minimum payout or within 90 days of termination, whichever comes first.`;

const ADVERTISER_TERMS = `These Advertiser Terms add to our Terms of Service and apply when you use {{productName}} to buy advertising. You must also follow the Advertiser Policies and Creative Rules.

# 1. Campaigns

You set each campaign's budget, schedule, bid or rate, targeting and creatives. Every campaign and creative is reviewed before it serves. Approval does not mean we confirm that your ads or landing pages are lawful; that remains your responsibility.

We do not guarantee that a campaign will deliver in full, on any particular site, or with any particular result. Targeting is applied on a best-efforts basis using the signals available, which may be limited by visitors' privacy choices.

# 2. Prepaid balance

Campaigns are paid from a prepaid balance. The smallest single deposit is {{minimumDeposit}}. Spend is deducted as valid impressions or clicks are recorded, at the rate set for the campaign. A campaign stops when its budget or your balance runs out.

# 3. What you pay for

You pay only for valid delivery under the pricing model of the campaign: valid impressions for a cost per thousand impressions campaign, valid clicks for a cost per click campaign, and the agreed amount for a flat-rate placement. Invalid traffic detected before billing is not charged. If invalid traffic is found after you were charged, we credit the amount back to your balance.

# 4. Refunds

You may ask for an unspent balance to be refunded within {{refundWindowDays}} of the deposit by writing to {{supportEmail}}. We refund to the original payment method where possible, less any fees the payment provider does not return to us. Promotional credits cannot be refunded.

# 5. Your ads and landing pages

You confirm that you have all rights needed in your creatives, trademarks and landing pages, and that they comply with the law (including consumer protection, advertising and privacy law) and with our policies. You are responsible for any tracking you run on your landing pages.

# 6. Placement

Your ads may appear on any approved publisher site that matches your targeting, unless you exclude it. We work to keep ads away from unsuitable content through site review and automatic page checks, but we cannot guarantee that an ad will never appear next to content you would not choose.

# 7. Reports

Reports in your dashboard are our record of delivery and spend. If you believe a report is wrong, tell us within 30 days of the end of the month concerned.

# 8. Taxes

Prices do not include taxes unless shown. You are responsible for taxes that apply to your purchases, other than taxes on our income.`;

const PRIVACY = `This Privacy Policy explains how {{companyName}} ("we", "us"), registered office {{companyAddress}}, handles personal data in connection with {{productName}}. It covers two groups of people: our customers (advertisers, publishers and their team members who use our dashboards) and visitors to publisher websites that show our ads.

# 1. Who is responsible

For customer account data, we are the controller. For data about visitors to publisher sites, we act as an independent controller for the data our ad tag collects to serve, measure and protect ads; the publisher is responsible for its own website and for collecting consent where the law requires it.

Contact for privacy questions and requests: {{privacyEmail}}.

# 2. Customer data

## What we collect

- Account details: name, email address, password (stored only as a secure hash), organisation name, role and settings.
- Business and payment details: billing address, tax details, payout details such as a PayPal address or bank account, and payment records. Card details are handled by our payment provider and never reach our servers.
- Usage and security data: sign-in history, IP address and browser at sign-in, actions taken in the dashboard (kept in an audit log), and support messages.

## Why we use it

- to provide the Network and your account (performance of our contract with you);
- to process payments and payouts, keep accounts and meet tax and anti-money-laundering obligations (legal obligation);
- to secure the Network and prevent fraud and invalid traffic (legitimate interests);
- to send service messages and, if you choose, scheduled reports (contract, and your choice).

We do not sell customer data.

# 3. Visitor data

When a visitor opens a page that carries our ad tag, the tag sends a request to our servers to choose an ad, and then reports whether the ad was shown, viewed and clicked.

## What we collect

- The page address and the referring site's host name (not the full referring address).
- Technical data: IP address, browser user agent, screen size and language. We do not store raw IP addresses: they are converted into a keyed hash that changes every day, so they cannot be linked across days. The approximate country derived from the IP address is kept.
- Ad events: which ad was requested, shown, in view, and clicked, with timestamps.
- Consent signals from the page: IAB TCF and GPP strings, US Privacy strings and Global Privacy Control.
- A random visitor identifier stored in the browser's local storage, only where personalised advertising is allowed for that visitor (see section 4).

## Why we use it

- to choose and deliver an ad that suits the page (contextual advertising);
- to count impressions, views and clicks so that advertisers are billed and publishers paid correctly;
- to detect and filter invalid traffic and fraud, which protects advertisers, publishers and visitors (legitimate interests);
- to cap how often a visitor sees the same ad and, only with consent where the law requires it, to personalise ads.

# 4. Consent and choices

Before an ad is requested the tag waits for the page's consent management platform. Where consent is required and has not been given, ads are contextual only: no visitor identifier is stored and no profile is built. Global Privacy Control and US opt-out signals are honoured as an opt-out. If a signal against personalisation appears later, the stored visitor identifier is deleted.

You can also clear our identifier at any time by clearing your browser's site data for the publisher's website.

# 5. Sharing

We share personal data only:

- with service providers who host, secure, email or process payments for us, under contracts that protect the data;
- with advertisers and publishers as aggregated reports that do not identify visitors;
- with authorities where the law requires it, or to protect rights, property or safety;
- with a buyer or successor if our business is reorganised or sold.

# 6. International transfers

Our providers may process data outside your country. Where data leaves the UK or the European Economic Area, we rely on adequacy decisions or standard contractual clauses.

# 7. Retention

Raw ad events are kept for {{rawRetentionDays}} and then deleted. Aggregated reports, which do not identify visitors, are kept for {{aggregateRetentionYears}}. Customer account data is kept while the account is open and afterwards for as long as needed for legal, tax and dispute purposes, normally up to seven years for financial records.

# 8. Security

Passwords are hashed, sensitive payout details are encrypted at rest, staff access is limited by role and logged, and connections are encrypted in transit. No system is perfectly secure; we will tell affected people and authorities about a breach where the law requires it.

# 9. Your rights

Depending on where you live, you may have the right to access, correct, delete or receive a copy of your personal data, to object to or restrict its use, to withdraw consent, and to opt out of the sale or sharing of personal data. To use these rights write to {{privacyEmail}}. Because we do not store raw IP addresses or names for visitors, we may need the identifier from your browser to find visitor data about you. You may also complain to your local data protection authority.

# 10. Children

The Network is not directed at children. We do not knowingly personalise ads for children, and publishers must tell us about sites directed at children so ads there stay contextual.

# 11. Changes

We will post changes here and update the date at the top. Material changes for customers are announced by email or in the dashboard.`;

const COOKIES = `This page explains the cookies and browser storage used by {{productName}}, operated by {{companyName}}. For how we use the data, see our Privacy Policy.

# On publisher websites (the ad tag)

The ad tag sets no cookies. It uses the browser's storage only as follows:

- bn_vid (local storage): a random visitor identifier used for frequency capping and, where allowed, personalised ads. Stored only when the server has decided that personalisation is allowed for the visitor, and deleted as soon as any signal against it appears. It is never set where consent is required but not given.
- bn_ist (session storage, or local storage where consent allows): the time an interstitial ad was last shown, so that one is shown at most once every 10 minutes.

Viewability, time in view and the referring site are measured in the page without storing anything.

# On our own website and dashboards

- bn_session (cookie, strictly necessary): keeps you signed in. Secure, HTTP-only, first-party, removed when you sign out or when the session expires.
- bn_csrf (cookie, strictly necessary): protects your account against cross-site request forgery.
- bn_current_org (local storage): remembers which of your organisations you last worked in.

We do not use advertising or analytics cookies on our own website.

# Managing storage

You can delete cookies and site data in your browser settings at any time. Blocking the strictly necessary cookies stops you from signing in. On publisher sites, use the site's consent tool to change your choices; refusing consent keeps our ads contextual.

Questions: {{privacyEmail}}.`;

const PUBLISHER_POLICIES: Array<[string, string, string]> = [
  ['eligibility', 'Site eligibility', `To join the network, a site must:

- be owned or controlled by you, and verified in your account;
- have original, substantial content that offers value to visitors, and be past its construction stage;
- have clear navigation, a working contact page or address, and a privacy policy that discloses third-party advertising;
- be in a supported language and country, and meet any traffic minimum shown on the publisher requirements page;
- receive its traffic from real people, through legitimate sources.

Sites made mainly to show ads, copied or automatically generated content without added value, parked domains and sites under construction are not accepted.`],
  ['prohibited-content', 'Prohibited content', `Ads may not be placed on pages that contain or link mainly to:

- sexually explicit content or nudity, or content that sexualises minors (we report the latter to the authorities);
- violent extremism, terrorism, or content that promotes violence or hatred against people because of who they are;
- harassment, threats, bullying or the publication of private information;
- illegal drugs, unlicensed weapons and explosives, or instructions to make them;
- counterfeit goods, pirated software, media or other copyright-infringing material, or tools to obtain it;
- hacking, malware, phishing or other harmful software;
- dishonest behaviour, such as fake documents, academic cheating or scams;
- misleading health or medical claims, or content that undermines elections or civic processes;
- shocking or gratuitously graphic content;
- unlicensed gambling, or gambling where it is illegal for the visitor.

Pages can also be flagged automatically by our page checks; flagged pages do not receive ads until they are reviewed.`],
  ['ad-placement', 'Ad placement and implementation', `- Use our ad tag without changing it. Do not hide, cover or restyle the "Sponsored" label.
- Do not place ads where they could be mistaken for site content, navigation, downloads or play buttons, and do not use labels such as "Recommended for you" that hide that they are ads.
- Do not place ads on pages with no content, error pages, thank-you pages, log-in pages or pages made mostly of ads. Ads must not outnumber content on a page.
- Do not place ads in pop-ups, emails, software, browser extensions or apps unless we approve it.
- Sticky, interstitial, pop-up and pop-under formats may be used only with the network's built-in controls and frequency limits.
- Auto-refresh only through the network's viewable refresh setting; do not reload ads with your own code.
- Keep your ads.txt file up to date with the line shown in your dashboard.`],
  ['invalid-traffic', 'Invalid traffic', `Invalid traffic is any impression or click that does not come from a real person's genuine interest. It includes:

- clicking your own ads, or asking anyone else to click them or view them, including with phrases like "support us by clicking";
- paying for, rewarding or incentivising visits, views or clicks;
- traffic from bots, automated tools, data-centre networks, click farms, or traffic exchanges;
- buying traffic from sources you have not checked, or that send visitors through pop-ups or redirects to your pages;
- manipulating how ads are shown, for example stacking them or making them invisible.

We check every event, hold new earnings for {{holdDays}} and remove invalid activity from earnings. Sites with high invalid traffic are reviewed and may be limited or closed. If you see unusual activity, tell us at {{supportEmail}}; reporting it yourself counts in your favour.`],
  ['privacy', 'Privacy and consent', `- Your privacy policy must say that third parties, including {{companyName}}, may serve ads, use browser storage and collect data such as IP addresses to deliver and measure ads.
- Where visitors are in the EEA, the UK or Switzerland, use a consent management platform certified for the IAB Transparency and Consent Framework, and let the ad tag read it.
- Honour US state opt-out laws, and do not suppress Global Privacy Control signals.
- Do not pass personal data such as names, email addresses or phone numbers to us in page addresses or in the tag.
- Tell us if a site is directed at children, so ads there stay contextual.`],
  ['payments', 'Payments, tax and identity', `- Earnings become available after the {{holdDays}} hold period and can be paid once they reach {{minimumPayout}}.
- Payout details must be in the name of the account holder or their business.
- We may ask for identity and tax information before paying, and hold payments until it is provided.
- One person or business may hold only one publisher account unless we agree otherwise.`],
  ['enforcement', 'Enforcement', `When a site breaks these policies we may, depending on how serious it is: stop ads on a page, limit ad serving on the site, remove the site, withhold earnings from invalid or prohibited activity, or close the account. Serious or repeated breaches can lead to closure without warning.

You will see enforcement actions in your dashboard. To appeal, reply to the notice or write to {{supportEmail}} with the site and what you have changed. We aim to respond within five working days.`],
];

const ADVERTISER_POLICIES: Array<[string, string, string]> = [
  ['prohibited', 'Prohibited ads', `We do not accept ads for:

- illegal products or services, and anything that promotes illegal activity;
- illegal or recreational drugs, drug paraphernalia, and unapproved supplements or pharmaceuticals;
- weapons, ammunition, explosives and instructions to make them;
- counterfeit goods, and products that infringe trademarks or copyright;
- adult content, sexual services or sexually explicit material;
- hate, violence, harassment, or content that exploits tragedies or sensitive events;
- tobacco, e-cigarettes and related products;
- malware, spyware, or software installed without clear consent;
- deceptive schemes: get-rich-quick offers, pyramid schemes, fake reviews, phishing, and anything designed to obtain personal or financial data under false pretences;
- products or services that help others deceive, such as fake documents or academic cheating.`],
  ['restricted', 'Restricted ads', `These categories need our approval in advance, must follow local law and may be limited to certain countries, ages or sites:

- alcohol: only where legal, only to adults, never aimed at minors;
- gambling and games of chance: only licensed operators, only in permitted countries;
- financial services, including loans, investments and cryptocurrency: must show who provides the service, its licence where required, and the main costs and risks;
- healthcare and medicines: must comply with local rules, and prescription medicines may not be advertised to the public where the law forbids it;
- political and issue ads: must say who paid for them, and may be refused in some countries or periods;
- dating services: must not be sexual or misleading.`],
  ['misrepresentation', 'Honesty and misrepresentation', `- Ads must be accurate. Do not make claims you cannot support, including "free" offers with hidden costs and before-and-after claims that are not typical.
- Show who you are: the advertiser or brand must be clear from the ad or the landing page.
- Do not imitate the publisher's site, system warnings, news articles or other brands in a way that misleads.
- Prices, discounts and offers in the ad must be available on the landing page.
- Endorsements must be genuine and permitted.`],
  ['landing-pages', 'Landing pages', `- The landing page must work, load quickly, match the ad, and be reachable in normal browsers.
- It must not redirect visitors to unrelated sites, download files automatically, open pop-ups that are hard to close, or trap the back button.
- It must clearly show who runs it and how to contact them, and have a privacy policy if it collects personal data.
- Any tracking or data collection on the landing page is your responsibility and must follow privacy law.`],
  ['targeting', 'Targeting and data', `- Do not target or exclude people based on sensitive characteristics such as health, religion, ethnicity, sexuality or financial hardship.
- Do not aim ads at children, and do not run ads for adult-only products on sites directed at children.
- Do not use our reports to identify individual visitors.
- Respect visitors' privacy choices: where personalisation is not allowed, ads are shown contextually and that cannot be bypassed.`],
  ['enforcement', 'Review and enforcement', `Every creative and campaign is reviewed before it serves, and ads can be reviewed again at any time, including after a change to the landing page. We may reject or stop ads that break these policies, suspend the campaign, or close the account for serious or repeated breaches. Spend already delivered for an ad that broke these policies is not refunded.

To appeal a decision, write to {{supportEmail}} with the campaign name and what you have changed.`],
];

const CREATIVE_RULES: Array<[string, string, string]> = [
  ['formats', 'Formats and files', `- Image creatives: JPEG, PNG, GIF or WebP, no larger than {{maxCreativeKb}}, at the exact size of the placement (for example 300×250, 728×90, 160×600, 320×50).
- Text and native creatives: a clear headline, a short description and a call to action, with an optional image for native ads.
- Every creative needs a working landing page address over HTTPS.`],
  ['quality', 'Quality and clarity', `- Images must be sharp and legible, with text in correct spelling and grammar.
- The ad must be clearly distinguishable from the page. Images with white or transparent backgrounds need a visible border.
- Do not use fake buttons, fake close icons, fake warnings or fake system messages.
- Animation may last no more than 30 seconds, and must not flash more than three times per second.
- No sound unless the visitor starts it.`],
  ['labels', 'Labelling', `Every ad is shown with a "Sponsored" label added by the network. Creatives must not hide, imitate or contradict it, and must not pretend to be editorial content.`],
];

const FAQS: Array<[string, string, string]> = [
  ['what-is-blissnova', 'What is {{productName}}?', `{{productName}} is an advertising network run by {{companyName}}. Advertisers fund an account and run campaigns; publishers add one ad tag to their sites and earn a share of the revenue. We handle review, ad delivery, measurement, invalid-traffic filtering and payouts.`],
  ['what-do-i-need-to-start', 'What do I need to start?', `Publishers need a website they own, with original content and a privacy policy. Add the site, verify it, wait for approval, create a placement and paste the ad tag into your pages. No plugin is needed.

Advertisers need to add funds (at least {{minimumDeposit}}), create a campaign and upload a creative. Both are reviewed before ads serve.`],
  ['how-long-does-review-take', 'How long does review take?', `Most sites, campaigns and creatives are reviewed within one to two working days. You will get an email when a decision is made, and the reason if anything is rejected, so you can fix it and submit again.`],
  ['how-are-clicks-counted', 'How are impressions and clicks counted?', `An impression is counted when the ad is actually rendered on the page, and a click when a visitor follows it. Every event is checked for invalid traffic, and only valid events are reported, billed and paid. Viewability is measured to the industry standard: at least half the ad in view for at least one second.`],
  ['how-much-can-i-earn', 'How much can I earn as a publisher?', `Earnings depend on your traffic, its countries and devices, your content and where the ads are placed. You receive {{revenueShare}} of what advertisers pay for valid ads on your sites, unless your account shows a different agreed share. Your dashboard shows earnings, page RPM and fill rate for every site and placement.`],
  ['when-do-publishers-get-paid', 'When and how do publishers get paid?', `New earnings are held for {{holdDays}} so invalid activity can be removed, then become available. Once your available balance reaches {{minimumPayout}} you can request a payout, or turn on automatic requests raised on {{payoutDay}}. Payouts are sent by PayPal, bank transfer or cryptocurrency, as offered in your account, after a review.`],
  ['what-is-invalid-traffic', 'What is invalid traffic, and why were my earnings adjusted?', `Invalid traffic is any impression or click that does not come from a real person's genuine interest, such as bots, accidental or encouraged clicks, or paid traffic. It is removed before billing and payment. If it is found later, earnings in the hold period are adjusted. Your Traffic quality page shows what was filtered and why.`],
  ['which-ad-formats', 'Which ad formats are available?', `Display banners in standard sizes, in-article, native, in-feed, sticky anchor, side rail, interstitial, text, pop-up and pop-under ads. Publishers decide which formats appear on their sites, and every ad carries a "Sponsored" label.`],
  ['how-do-advertisers-pay', 'How do advertisers pay?', `Campaigns run from a prepaid balance. You can add funds by card or PayPal, and spend is deducted only for valid impressions or clicks at the rate you set. You can ask for an unspent balance to be refunded within {{refundWindowDays}} of the deposit.`],
  ['targeting-options', 'How can I target my ads?', `By country, device type, site category, keyword, page topic, site and placement, with start and end dates and frequency caps. You can also exclude sites, placements and topics, and choose a brand-safety level. Where visitors have not consented to personalised ads, ads are chosen from the page's context only.`],
  ['privacy-and-consent', 'Does the network respect privacy and consent?', `Yes. The ad tag reads IAB TCF and GPP consent platforms, US Privacy strings and Global Privacy Control before requesting an ad. Without consent where it is required, ads stay contextual and nothing is stored in the visitor's browser. Raw IP addresses are never stored. See the Privacy Policy and the Cookies page for details.`],
  ['brand-safety', 'How do you keep ads away from unsuitable content?', `Every site is reviewed before it can show ads, and each page is checked automatically for its topic and for sensitive content. Pages that look unsafe do not get ads until a person has reviewed them. Advertisers can also target or exclude topics and sites.`],
  ['ads-txt', 'Do I need an ads.txt file?', `Yes. Add the line shown on your site's page in the dashboard to the ads.txt file at the root of your domain. It tells buyers that we are authorised to sell your inventory, and missing lines can reduce demand.`],
  ['contact-support', 'How do I contact support?', `Open a support ticket from your dashboard, or email {{supportEmail}}. To report an ad or a site that breaks our policies, use the Report an ad or site page.`],
];

export const STARTER_CONTENT: readonly StarterContent[] = [
  { kind: 'legal', slug: 'terms', title: 'Terms of Service', body: TERMS, sortOrder: 1 },
  { kind: 'legal', slug: 'publisher-terms', title: 'Publisher Terms', body: PUBLISHER_TERMS, sortOrder: 2 },
  { kind: 'legal', slug: 'advertiser-terms', title: 'Advertiser Terms', body: ADVERTISER_TERMS, sortOrder: 3 },
  { kind: 'legal', slug: 'privacy', title: 'Privacy Policy', body: PRIVACY, sortOrder: 4 },
  { kind: 'legal', slug: 'cookies', title: 'Cookies and Tracking', body: COOKIES, sortOrder: 5 },
  ...PUBLISHER_POLICIES.map(([slug, title, body], i) => ({ kind: 'publisher_policy' as const, slug, title, body, sortOrder: i + 1 })),
  ...ADVERTISER_POLICIES.map(([slug, title, body], i) => ({ kind: 'advertiser_policy' as const, slug, title, body, sortOrder: i + 1 })),
  ...CREATIVE_RULES.map(([slug, title, body], i) => ({ kind: 'creative_rules' as const, slug, title, body, sortOrder: i + 1 })),
  ...FAQS.map(([slug, title, body], i) => ({ kind: 'faq' as const, slug, title, body, sortOrder: i + 1 })),
];
