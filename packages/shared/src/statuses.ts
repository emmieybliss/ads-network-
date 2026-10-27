export const CAMPAIGN_STATUSES = ['draft', 'pending_approval', 'scheduled', 'active', 'paused', 'completed', 'rejected', 'suspended', 'archived'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Transitions an advertiser can perform. Admin transitions are separate. */
export const ADVERTISER_CAMPAIGN_TRANSITIONS: Record<string, CampaignStatus[]> = {
  submit: ['draft', 'rejected'],
  pause: ['active', 'scheduled'],
  resume: ['paused'],
  archive: ['draft', 'rejected', 'completed', 'paused'],
};

export const ADMIN_CAMPAIGN_TRANSITIONS: Record<string, CampaignStatus[]> = {
  approve: ['pending_approval'],
  reject: ['pending_approval'],
  pause: ['active', 'scheduled'],
  resume: ['paused', 'suspended'],
  suspend: ['active', 'scheduled', 'paused', 'pending_approval'],
  terminate: ['active', 'scheduled', 'paused', 'suspended'],
};

/** Statuses whose campaign settings may be edited by the advertiser. Editing an approved campaign's targeting or creative requires re-review. */
export const EDITABLE_CAMPAIGN_STATUSES: CampaignStatus[] = ['draft', 'rejected', 'paused', 'scheduled', 'active'];

export const ORG_STATUSES = ['pending', 'approved', 'rejected', 'suspended'] as const;
/**
 * Publisher site lifecycle. Verification proves control of a hostname; it never
 * approves a site on its own. Approval is a separate review step.
 */
export const SITE_STATUSES = ['draft', 'verification_pending', 'verified', 'submitted', 'under_review', 'approved', 'rejected', 'suspended'] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

export const SITE_STATUS_LABELS: Record<SiteStatus, string> = {
  draft: 'Draft',
  verification_pending: 'Verification pending',
  verified: 'Verified',
  submitted: 'Submitted for review',
  under_review: 'Under review',
  approved: 'Approved',
  rejected: 'Rejected',
  suspended: 'Suspended',
};

/** Admin site actions: action -> statuses it may be applied from. */
export const ADMIN_SITE_TRANSITIONS: Record<string, SiteStatus[]> = {
  'start-review': ['submitted'],
  approve: ['submitted', 'under_review'],
  reject: ['verification_pending', 'verified', 'submitted', 'under_review'],
  suspend: ['approved', 'submitted', 'under_review', 'verified'],
  reinstate: ['suspended'],
};
export const CREATIVE_STATUSES = ['draft', 'pending_review', 'approved', 'rejected', 'archived'] as const;
export const AD_UNIT_STATUSES = ['active', 'paused', 'archived'] as const;
export const PRICING_MODELS = ['cpm', 'cpc', 'flat'] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];
export const DEVICE_TYPES = ['desktop', 'mobile', 'tablet', 'other'] as const;
export const AD_FORMATS = ['image', 'text', 'native'] as const;
export type AdFormat = (typeof AD_FORMATS)[number];
export const ORG_TIERS = ['standard', 'premium'] as const;
export type OrgTier = (typeof ORG_TIERS)[number];
/** How a premium publisher's minimum earnings are honoured. */
export const EARNINGS_MODES = ['floor', 'guarantee'] as const;
export type EarningsMode = (typeof EARNINGS_MODES)[number];
export const VERIFICATION_METHODS = ['dns_txt', 'html_file', 'meta_tag'] as const;

/** Event state model. A served ad is never an impression on its own. */
export const EVENT_TYPES = ['request', 'served', 'render', 'viewable', 'click', 'cap_reject', 'budget_reject'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const EVENT_STATUSES = ['valid', 'invalid'] as const;
export const INVALID_REASONS = [
  'duplicate', 'token_invalid', 'token_expired', 'replay', 'domain_mismatch', 'crawler', 'rate_anomaly',
  'sequence', 'click_too_fast', 'click_burst', 'site_inactive', 'manual_exclusion', 'tracking_disabled', 'anomaly_score',
] as const;
export type InvalidReason = (typeof INVALID_REASONS)[number];

export const PAYOUT_STATUSES = ['requested', 'approved', 'processing', 'paid', 'rejected', 'failed', 'cancelled'] as const;
export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'cancelled'] as const;
