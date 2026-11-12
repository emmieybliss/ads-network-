/**
 * Page topics and brand-safety categories used by contextual targeting.
 *
 * Topics follow the tier-1 categories of the IAB Tech Lab Content Taxonomy
 * by name (a few closely related IAB tier-1 categories are merged, noted
 * below). Ids are short slugs of our own; they are stable and stored in the
 * database, so never rename one. Where a slug matches a site category
 * (technology, travel, food, ...), it means the same thing.
 */
export const TOPICS = [
  { id: 'automotive', label: 'Automotive' },
  { id: 'books_literature', label: 'Books & Literature' },
  { id: 'business', label: 'Business' },
  { id: 'careers', label: 'Careers' },
  { id: 'education', label: 'Education' },
  { id: 'arts_culture', label: 'Arts & Culture' }, // IAB "Fine Art" and "Events & Attractions"
  { id: 'parenting', label: 'Family & Parenting' }, // IAB "Family and Relationships"
  { id: 'food', label: 'Food & Drink' },
  { id: 'fitness', label: 'Healthy Living' },
  { id: 'health', label: 'Medical Health' },
  { id: 'hobbies', label: 'Hobbies & Interests' },
  { id: 'home_garden', label: 'Home & Garden' },
  { id: 'movies', label: 'Movies' },
  { id: 'music', label: 'Music & Audio' },
  { id: 'television', label: 'Television' },
  { id: 'news', label: 'News & Politics' },
  { id: 'finance', label: 'Personal Finance' },
  { id: 'pets', label: 'Pets' },
  { id: 'real_estate', label: 'Real Estate' },
  { id: 'religion', label: 'Religion & Spirituality' },
  { id: 'science', label: 'Science' },
  { id: 'shopping', label: 'Shopping' },
  { id: 'sports', label: 'Sports' },
  { id: 'fashion', label: 'Style & Fashion' },
  { id: 'technology', label: 'Technology & Computing' },
  { id: 'travel', label: 'Travel' },
  { id: 'gaming', label: 'Video Gaming' },
] as const;

export type TopicId = (typeof TOPICS)[number]['id'];
export const TOPIC_IDS = TOPICS.map((t) => t.id) as unknown as readonly [TopicId, ...TopicId[]];
const TOPIC_LABELS: Record<string, string> = Object.fromEntries(TOPICS.map((t) => [t.id, t.label]));

/** Human label for a topic id; unknown ids are shown as "Uncategorized". */
export function topicLabel(id: string | null | undefined): string {
  return (id && TOPIC_LABELS[id]) || 'Uncategorized';
}

export function isTopicId(id: string): id is TopicId {
  return id in TOPIC_LABELS;
}

/**
 * Topics assumed for a page that has not been classified yet, from the
 * category the publisher chose for the whole site. Broad categories map to
 * several topics; "general" and "other" map to none.
 */
export const SITE_CATEGORY_TOPICS: Record<string, TopicId[]> = {
  general: [],
  other: [],
  news: ['news'],
  technology: ['technology'],
  business: ['business'],
  finance: ['finance'],
  lifestyle: ['fashion', 'fitness', 'home_garden'],
  entertainment: ['movies', 'television', 'music'],
  sports: ['sports'],
  education: ['education'],
  health: ['health', 'fitness'],
  travel: ['travel'],
  food: ['food'],
  automotive: ['automotive'],
  gaming: ['gaming'],
  parenting: ['parenting'],
  real_estate: ['real_estate'],
  science: ['science'],
};

/**
 * Brand-safety categories, modelled on the sensitive-content categories
 * advertisers commonly avoid. Detection only flags; what happens next depends
 * on each campaign's brand-safety level and the network setting for
 * high-risk pages.
 */
export const SAFETY_CATEGORIES = [
  { id: 'adult', label: 'Adult & explicit sexual content' },
  { id: 'violence', label: 'Violence & graphic content' },
  { id: 'weapons', label: 'Arms & ammunition' },
  { id: 'crime_tragedy', label: 'Crime, death & tragedy' },
  { id: 'hate', label: 'Hate speech & extremism' },
  { id: 'drugs', label: 'Illegal drugs' },
  { id: 'profanity', label: 'Obscenity & profanity' },
  { id: 'gambling', label: 'Gambling' },
] as const;
export type SafetyCategoryId = (typeof SAFETY_CATEGORIES)[number]['id'];
const SAFETY_LABELS: Record<string, string> = Object.fromEntries(SAFETY_CATEGORIES.map((c) => [c.id, c.label]));
export function safetyCategoryLabel(id: string): string {
  return SAFETY_LABELS[id] ?? id;
}

/** Risk of a page, lowest first. "unknown" means the page has not been checked. */
export const SAFETY_LEVELS = ['safe', 'low', 'medium', 'high'] as const;
export type SafetyLevel = (typeof SAFETY_LEVELS)[number];
export type PageSafety = SafetyLevel | 'unknown';

export const SAFETY_LEVEL_LABELS: Record<PageSafety, string> = {
  safe: 'Safe', low: 'Low risk', medium: 'Medium risk', high: 'High risk', unknown: 'Not checked yet',
};

/**
 * What a campaign accepts:
 * - strict: only pages that were checked and found safe.
 * - standard (default): safe and low-risk pages, and pages not checked yet.
 * - relaxed: everything except high-risk pages.
 */
export const BRAND_SAFETY_MODES = ['strict', 'standard', 'relaxed'] as const;
export type BrandSafetyMode = (typeof BRAND_SAFETY_MODES)[number];

export function brandSafetyAllows(mode: BrandSafetyMode | undefined, page: PageSafety): boolean {
  switch (mode ?? 'standard') {
    case 'strict': return page === 'safe';
    case 'relaxed': return page !== 'high';
    default: return page === 'safe' || page === 'low' || page === 'unknown';
  }
}
