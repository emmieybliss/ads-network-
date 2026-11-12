import { createHash } from 'node:crypto';
import type { PageSafety, SafetyCategoryId, SafetyLevel, TopicId } from '@blissnova/shared';

/**
 * Contextual page classifier. Pure and local: no network calls and no paid
 * services. It reads the text signals the ad tag sends for a page (title,
 * description, headings, keywords, path and a sample of the main text) and
 * returns the page's topics and brand-safety risk.
 *
 * Method: a weighted term dictionary per topic. Each field has a weight
 * (the title counts most, body text least); repeated terms count with
 * diminishing returns; a topic needs enough distinct evidence before it is
 * reported. Brand safety uses separate term lists with a risk weight per term.
 * English only: other languages come back uncategorized, and the page falls
 * back to its site category.
 *
 * Bump CLASSIFIER_VERSION whenever the dictionaries or scoring change, so
 * stored results are recomputed.
 */
export const CLASSIFIER_VERSION = 1;

export interface PageSignals {
  title?: string;
  description?: string;
  headings?: string[];
  keywords?: string[];
  path?: string;
  text?: string;
  lang?: string;
}

export interface TopicScore { id: TopicId; score: number; confidence: number }
export interface SafetyFlag { category: SafetyCategoryId; risk: Exclude<SafetyLevel, 'safe'>; score: number; terms: string[] }
export interface Classification {
  version: number;
  topics: TopicScore[];
  primary: TopicId | null;
  safety: SafetyLevel;
  flags: SafetyFlag[];
  /** Dictionary terms found on the page, strongest first; usable as page keywords. */
  terms: string[];
  /** Hash of the normalized input, to tell when a page's text changed. */
  hash: string;
  /** False when the page had too little English text to judge. */
  enoughText: boolean;
}

/* --------------------------------------------------------------- dictionaries
 * Each entry is a word or phrase. A leading "!" marks a strong term (weight 2)
 * and a leading "~" a weak, ambiguous one (weight 0.5); others weigh 1.
 */
const TOPIC_TERMS: Record<TopicId, string[]> = {
  automotive: ['!car', '!cars', '!vehicle', '!suv', '!sedan', '!hatchback', '!pickup truck', '!electric vehicle', '!ev charging', '!horsepower', '!test drive', '!dealership', '!car insurance', '!motorcycle', 'engine', 'mpg', 'torque', 'transmission', 'tyre', 'tire', 'brake', 'mileage', 'hybrid', 'driver', 'driving', 'road trip', 'car loan', 'oil change', 'toyota', 'ford', 'honda', 'tesla', 'bmw', 'volkswagen', 'hyundai', 'kia', 'nissan', 'chevrolet', 'mercedes', 'audi', 'porsche', '~model', '~garage'],
  books_literature: ['!novel', '!novelist', '!author', '!poetry', '!poem', '!book review', '!bestseller', '!fiction', '!nonfiction', '!literary', '!paperback', '!hardcover', '!memoir', '!audiobook', 'chapter', 'publisher', 'reading list', 'book club', 'library', 'writer', 'storytelling', 'manuscript', 'short story', 'literature', '~book', '~books', '~read'],
  business: ['!business', '!startup', '!entrepreneur', '!small business', '!revenue', '!marketing', '!ceo', '!b2b', '!supply chain', '!merger', '!acquisition', 'company', 'companies', 'customer', 'sales', 'management', 'leadership', 'strategy', 'profit', 'quarterly', 'shareholder', 'industry', 'market share', 'branding', 'advertising', 'e-commerce', 'ecommerce', 'franchise', 'logistics', 'invoice', 'productivity', 'workplace', 'team', 'meeting', 'manager', 'stakeholder', '~growth', '~market'],
  careers: ['!job', '!jobs', '!career', '!resume', '!cv', '!job interview', '!hiring', '!recruiter', '!salary', '!internship', '!job search', '!cover letter', '!promotion', 'workday', 'work from home', 'remote work', 'employer', 'employee', 'coworker', 'colleague', 'linkedin', 'job offer', 'burnout', 'work-life balance', 'onboarding', 'freelance', 'freelancer', 'skill', 'skills', '~office', '~boss'],
  education: ['!school', '!student', '!students', '!teacher', '!university', '!college', '!classroom', '!curriculum', '!homework', '!exam', '!degree', '!scholarship', '!tuition', '!online course', '!lesson', 'learning', 'learn', 'education', 'study', 'studying', 'graduate', 'campus', 'professor', 'kindergarten', 'tutor', 'tutoring', 'syllabus', 'semester', 'grammar', 'math', 'mathematics', '~course', '~class'],
  arts_culture: ['!art', '!artist', '!painting', '!sculpture', '!museum', '!gallery', '!exhibition', '!theatre', '!theater', '!opera', '!ballet', '!festival', 'photography', 'artwork', 'design', 'drawing', 'illustration', 'culture', 'cultural', 'heritage', 'architecture', 'concert hall', 'craft', 'ceramics', 'watercolor', 'watercolour', 'canvas', 'curator'],
  parenting: ['!parenting', '!parent', '!parents', '!toddler', '!baby', '!babies', '!newborn', '!pregnancy', '!pregnant', '!breastfeeding', '!kids', '!child', '!children', '!childcare', '!daycare', 'mom', 'mum', 'dad', 'family', 'families', 'nursery', 'diaper', 'nappy', 'bedtime', 'tantrum', 'teenager', 'teen', 'sibling', 'grandparent', 'marriage', 'wedding', 'relationship', 'dating'],
  food: ['!recipe', '!recipes', '!cooking', '!cook', '!baking', '!bake', '!restaurant', '!chef', '!cuisine', '!ingredient', '!ingredients', '!dinner', '!lunch', '!breakfast', '!dessert', '!wine', '!coffee', 'pasta', 'sauce', 'oven', 'kitchen', 'meal', 'meals', 'flavor', 'flavour', 'garlic', 'onion', 'tomato', 'cheese', 'bread', 'salad', 'soup', 'chicken', 'beef', 'vegan', 'vegetarian', 'grill', 'tablespoon', 'teaspoon', 'simmer', 'cocktail', 'beer', 'tea', 'snack', 'pizza', 'cake', 'cookie', 'spice', 'food', 'menu', 'dish', 'weeknight', '~salt', '~pepper', '~serve'],
  fitness: ['!fitness', '!workout', '!exercise', '!gym', '!yoga', '!pilates', '!running', '!jogging', '!marathon', '!weight loss', '!nutrition', '!wellness', '!meditation', '!mindfulness', 'stretching', 'cardio', 'strength training', 'protein', 'calorie', 'calories', 'diet', 'healthy', 'habit', 'habits', 'sleep', 'stress', 'calm', 'calmer', 'self-care', 'hydration', 'steps', 'mental health', 'relax', 'breathing', 'posture', 'break', 'walk'],
  health: ['!doctor', '!hospital', '!disease', '!symptom', '!symptoms', '!diagnosis', '!treatment', '!medication', '!vaccine', '!patient', '!patients', '!surgery', '!clinic', '!diabetes', '!cancer', '!blood pressure', '!physician', '!nurse', 'infection', 'virus', 'therapy', 'chronic', 'prescription', 'pharmacy', 'medical', 'health', 'healthcare', 'allergy', 'asthma', 'pain', 'heart disease', 'cholesterol', 'dentist', 'dental', 'clinical trial', 'immune', '~care'],
  hobbies: ['!hobby', '!hobbies', '!diy', '!knitting', '!crochet', '!sewing', '!woodworking', '!camping', '!hiking', '!fishing', '!board game', '!puzzle', '!chess', '!collecting', 'craft project', 'model kit', 'birdwatching', 'scrapbooking', 'pottery', 'quilting', 'outdoors', 'trail', 'backpacking', 'genealogy', 'origami', 'lego', 'magic trick'],
  home_garden: ['!houseplant', '!houseplants', '!garden', '!gardening', '!plant', '!plants', '!soil', '!repot', '!pot', '!pots', '!lawn', '!interior design', '!home improvement', '!renovation', '!furniture', '!decor', '!kitchen remodel', 'watering', 'water', 'leaves', 'leaf', 'roots', 'seed', 'seeds', 'compost', 'fertilizer', 'succulent', 'fern', 'flower', 'flowers', 'bloom', 'pest', 'pests', 'drainage', 'shade', 'sunlight', 'cleaning', 'laundry', 'bedroom', 'living room', 'bathroom', 'paint', 'wallpaper', 'shelf', 'sofa', 'rug', 'cushion', 'home', 'household', 'mite', 'mites', 'greenhouse', 'nursery pot'],
  movies: ['!movie', '!movies', '!film', '!films', '!cinema', '!box office', '!director', '!actor', '!actress', '!trailer', '!screenplay', '!oscar', '!sequel', 'hollywood', 'premiere', 'cast', 'blockbuster', 'documentary', 'animation', 'streaming', 'netflix', 'disney', 'marvel', 'horror film', 'comedy', 'thriller', 'review', '~scene'],
  music: ['!music', '!song', '!songs', '!album', '!singer', '!band', '!concert', '!guitar', '!piano', '!drummer', '!playlist', '!lyrics', '!podcast', '!rapper', 'tour', 'spotify', 'vinyl', 'melody', 'chord', 'jazz', 'hip hop', 'rock', 'pop music', 'classical music', 'orchestra', 'festival lineup', 'producer', 'single', 'radio', 'audio', 'headphones', 'speaker'],
  television: ['!tv', '!television', '!tv show', '!series', '!episode', '!season finale', '!sitcom', '!reality show', '!showrunner', 'streaming service', 'broadcast', 'channel', 'binge', 'miniseries', 'talk show', 'presenter', 'premiere date', 'cliffhanger', 'spin-off', 'emmy'],
  news: ['!election', '!government', '!president', '!prime minister', '!parliament', '!congress', '!senate', '!minister', '!policy', '!politics', '!political', '!breaking news', '!lawmakers', '!legislation', 'vote', 'voters', 'campaign trail', 'officials', 'official', 'police', 'court', 'judge', 'law', 'protest', 'reported', 'reporter', 'according to', 'spokesperson', 'announced', 'city council', 'mayor', 'governor', 'war', 'storm', 'flood', 'weather', 'emergency', 'investigation', 'authorities', 'residents', 'crisis', 'international', 'diplomat', 'sanctions', '~news', '~statement'],
  finance: ['!investing', '!investment', '!invest', '!stock', '!stocks', '!index fund', '!index funds', '!etf', '!mutual fund', '!retirement', '!pension', '!401k', '!savings', '!mortgage', '!credit card', '!credit score', '!budget', '!budgeting', '!loan', '!interest rate', '!inflation', '!tax', '!taxes', '!personal finance', '!cryptocurrency', '!bitcoin', 'bank', 'banking', 'money', 'debt', 'portfolio', 'dividend', 'bond', 'bonds', 'fee', 'fees', 'expense ratio', 'compound interest', 'emergency fund', 'financial', 'wealth', 'insurance', 'income', 'spending', 'saving', 'diversify', 'brokerage', 'returns', '~fund', '~funds', '~market'],
  pets: ['!dog', '!dogs', '!puppy', '!cat', '!cats', '!kitten', '!pet', '!pets', '!veterinarian', '!vet', '!pet food', 'leash', 'litter box', 'breed', 'grooming', 'aquarium', 'hamster', 'rabbit', 'parrot', 'adopt a pet', 'shelter', 'flea', 'chew toy', 'obedience'],
  real_estate: ['!real estate', '!property', '!realtor', '!estate agent', '!house prices', '!home buyer', '!first-time buyer', '!rent', '!rental', '!landlord', '!tenant', '!apartment', '!condo', '!listing', '!down payment', 'housing market', 'square feet', 'bedroom house', 'open house', 'closing costs', 'appraisal', 'zoning', 'lease', 'neighborhood', 'neighbourhood', '~home'],
  religion: ['!religion', '!religious', '!church', '!mosque', '!synagogue', '!temple', '!prayer', '!bible', '!quran', '!torah', '!faith', '!spiritual', '!spirituality', 'god', 'worship', 'pastor', 'priest', 'imam', 'rabbi', 'christian', 'muslim', 'jewish', 'hindu', 'buddhist', 'buddhism', 'sermon', 'scripture', 'ramadan', 'christmas', 'easter', 'diwali'],
  science: ['!science', '!scientist', '!scientists', '!research', '!researchers', '!physics', '!chemistry', '!biology', '!astronomy', '!nasa', '!experiment', '!laboratory', '!species', '!climate change', '!genome', '!telescope', 'study', 'evolution', 'planet', 'space', 'galaxy', 'molecule', 'atom', 'fossil', 'dinosaur', 'ecosystem', 'quantum', 'theory', 'data', 'peer-reviewed', 'journal', 'carbon', 'emissions', 'ocean', 'geology', 'volcano', 'earthquake'],
  shopping: ['!shopping', '!deal', '!deals', '!discount', '!coupon', '!sale', '!black friday', '!cyber monday', '!buying guide', '!gift guide', '!best buy', 'price', 'prices', 'cheap', 'affordable', 'retailer', 'store', 'shop', 'checkout', 'free shipping', 'promo code', 'bargain', 'gift', 'gifts', 'product review', 'amazon', 'compare'],
  sports: ['!football', '!soccer', '!basketball', '!baseball', '!tennis', '!cricket', '!rugby', '!golf', '!hockey', '!nba', '!nfl', '!premier league', '!world cup', '!olympics', '!championship', '!tournament', '!athlete', '!coach', 'match', 'team', 'season', 'player', 'players', 'score', 'goal', 'league', 'stadium', 'fans', 'playoff', 'playoffs', 'transfer', 'boxing', 'formula 1', 'cycling', 'race', 'medal', 'referee', 'striker', 'quarterback'],
  fashion: ['!fashion', '!style', '!outfit', '!outfits', '!clothing', '!dress', '!shoes', '!sneakers', '!makeup', '!skincare', '!beauty', '!designer', '!runway', '!jewelry', '!jewellery', 'wardrobe', 'trend', 'trends', 'handbag', 'lipstick', 'hairstyle', 'haircut', 'denim', 'jacket', 'accessories', 'perfume', 'manicure', 'model', 'collection', 'vogue'],
  technology: ['!software', '!smartphone', '!laptop', '!computer', '!programming', '!javascript', '!typescript', '!python', '!artificial intelligence', '!machine learning', '!cybersecurity', '!semiconductor', '!developer', '!developers', '!operating system', '!processor', '!gpu', '!cloud computing', '!api', '!ad tag', '!browser', 'app', 'apps', 'ai', 'gadget', 'chip', 'internet', 'wifi', 'router', 'android', 'iphone', 'database', 'server', 'tech', 'algorithm', 'digital', 'device', 'devices', 'robot', 'robotics', 'website', 'web', 'online', 'code', 'cookies', 'snippet', 'script', 'endpoint', 'dashboard', 'pixel', 'privacy', 'encryption', 'data', '~windows', '~apple', '~tag'],
  travel: ['!travel', '!traveling', '!travelling', '!trip', '!vacation', '!holiday', '!flight', '!flights', '!airline', '!airport', '!hotel', '!hotels', '!destination', '!itinerary', '!passport', '!tourist', '!tourism', '!backpacking', '!cruise', '!sightseeing', 'beach', 'resort', 'luggage', 'visa', 'booking', 'guidebook', 'museum', 'old town', 'tram', 'train', 'hostel', 'airbnb', 'city break', 'weekend', 'explore', 'visit', 'visitors', 'local', 'neighborhood', 'neighbourhood', 'view', 'lisbon', 'paris', 'london', 'rome', 'tokyo', 'barcelona', 'new york'],
  gaming: ['!video game', '!video games', '!gaming', '!gamer', '!gamers', '!playstation', '!xbox', '!nintendo', '!steam', '!esports', '!console', '!multiplayer', '!game review', 'game', 'games', 'gameplay', 'level', 'boss fight', 'speedrun', 'twitch', 'controller', 'rpg', 'shooter', 'open world', 'patch notes', 'dlc', 'mod', 'mods', 'minecraft', 'fortnite'],
};

/** Brand-safety terms. "!" marks a high-risk term (weight 3); others weigh 1 and "~" ones 0.5. */
const SAFETY_TERMS: Record<SafetyCategoryId, string[]> = {
  adult: ['!porn', '!porno', '!pornography', '!pornographic', '!xxx', '!hardcore sex', '!sex video', '!sex tape', '!nude photos', '!nudes', '!escort service', '!camgirl', '!hentai', '!explicit sex', 'erotic', 'erotica', 'nude', 'naked', 'stripper', 'fetish', 'onlyfans', 'adult content', '~sexy', '~lingerie', '~sex'],
  violence: ['!beheading', '!beheaded', '!massacre', '!gore', '!graphic violence', '!mass shooting', '!terror attack', '!terrorist attack', '!bloodbath', '!mutilated', '!torture', 'shooting', 'stabbing', 'stabbed', 'gunman', 'assault', 'assaulted', 'bombing', 'terrorism', 'terrorist', 'shot dead', 'brutal', 'violence', 'violent', 'killing', 'killed', '~war', '~attack', '~fight'],
  weapons: ['!assault rifle', '!gun shop', '!buy guns', '!ammunition sale', '!explosives', 'firearm', 'firearms', 'rifle', 'handgun', 'pistol', 'shotgun', 'ammunition', 'ammo', 'gun', 'guns', 'weapon', 'weapons', 'grenade', '~knife', '~knives'],
  crime_tragedy: ['!murder', '!murdered', '!homicide', '!fatal crash', '!death toll', '!kidnapping', '!kidnapped', '!suicide', 'crime', 'criminal', 'robbery', 'burglary', 'arrested', 'victim', 'victims', 'tragedy', 'tragic', 'disaster', 'casualties', 'fatal', 'funeral', 'mourning', 'body found', 'missing person', 'manslaughter', '~died', '~dead', '~death', '~injured', '~crash', '~police'],
  hate: ['!white supremacy', '!white supremacist', '!neo-nazi', '!neo nazi', '!ethnic cleansing', '!hate group', '!racial slur', 'hate speech', 'racist', 'racism', 'extremist', 'extremism', 'bigotry', 'xenophobia', 'antisemitism', 'antisemitic', 'islamophobia', 'homophobic', 'radicalized', 'radicalised'],
  drugs: ['!cocaine', '!heroin', '!methamphetamine', '!crystal meth', '!fentanyl', '!buy weed', '!drug dealer', '!drug trafficking', 'cannabis', 'marijuana', 'weed', 'overdose', 'narcotics', 'opioid', 'opioids', 'ecstasy', 'lsd', 'psychedelic', 'drug abuse', 'addiction', '~drugs', '~high'],
  profanity: ['!fuck', '!fucking', '!motherfucker', '!cunt', 'shit', 'bullshit', 'bitch', 'asshole', 'bastard', 'dickhead', 'piss', '~damn', '~crap', '~hell'],
  gambling: ['!online casino', '!casino bonus', '!sports betting', '!sportsbook', '!slot machine', '!slots', '!free spins', 'casino', 'betting', 'bet', 'bets', 'poker', 'roulette', 'blackjack', 'wager', 'bookmaker', 'jackpot', 'gambling', 'odds', '~lottery'],
};

/** How much each field counts. */
const FIELD_WEIGHT = { title: 3, description: 2, headings: 2, keywords: 2, path: 1.5, text: 1 } as const;
type Field = keyof typeof FIELD_WEIGHT;

/** Field length limits, applied before classification (the API validates them too). */
export const SIGNAL_LIMITS = { title: 300, description: 500, heading: 160, headings: 12, keyword: 60, keywords: 20, path: 300, text: 6000, lang: 20 } as const;

const MIN_TOPIC_SCORE = 6;
const MIN_TOPIC_TERMS = 2;
const SECONDARY_SHARE = 0.45;
const MAX_TOPICS = 3;

/* ---------------------------------------------------------------- tokenizer */

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'it', 'its', 'this', 'that', 'at', 'by', 'from', 'as', 'your', 'you', 'we', 'our', 'they', 'their', 'not', 'but', 'if', 'so', 'can', 'will', 'more', 'most', 'than', 'then', 'into', 'about', 'how', 'what', 'when', 'which', 'who', 'all', 'one', 'two', 'out', 'up', 'do', 'does', 'have', 'has', 'had', 'there', 'here', 'very', 'just', 'also', 'only', 'some', 'any', 'each', 'other', 'such', 'no', 'yes', 'i', 'he', 'she', 'his', 'her', 'them', 'my', 'me', 'us', 'these', 'those', 'over', 'under', 'after', 'before', 'while', 'where', 'why', 'would', 'could', 'should', 'may', 'might', 'must', 'been', 'being', 'own', 'same', 'too', 'few', 'many', 'much', 'every', 'off', 'again', 'once', 'new', 'get', 'got', 'use', 'used', 'using', 'make', 'made', 'like', 'way', 'time', 'year', 'years', 'day', 'days']);

/** Light English normalization so "plants", "plant" and "plant's" match the same entry. */
function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(sh|ch|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const m of s.toLowerCase().normalize('NFKC').matchAll(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)) {
    out.push(stem(m[0].replace(/’/g, "'")));
  }
  return out;
}

interface Entry { key: string; label: string; weight: number; n: number }
interface Dict { byFirst: Map<string, Entry[]> }

function buildDict(lists: Record<string, string[]>, strong: number, weak: number): Map<string, Dict> {
  const out = new Map<string, Dict>();
  for (const [id, terms] of Object.entries(lists)) {
    const byFirst = new Map<string, Entry[]>();
    for (const raw of terms) {
      const weight = raw.startsWith('!') ? strong : raw.startsWith('~') ? weak : 1;
      const label = raw.replace(/^[!~]/, '');
      const toks = tokenize(label);
      if (toks.length === 0) continue;
      const e: Entry = { key: toks.join(' '), label, weight, n: toks.length };
      const list = byFirst.get(toks[0]!) ?? [];
      if (!list.some((x) => x.key === e.key)) list.push(e);
      byFirst.set(toks[0]!, list);
    }
    out.set(id, { byFirst });
  }
  return out;
}

const TOPIC_DICT = buildDict(TOPIC_TERMS, 2, 0.5);
const SAFETY_DICT = buildDict(SAFETY_TERMS, 3, 0.5);

/** Count each dictionary entry's matches in a token list (phrases match on consecutive tokens). */
function matchCounts(tokens: string[], dict: Dict): Map<Entry, number> {
  const counts = new Map<Entry, number>();
  for (let i = 0; i < tokens.length; i++) {
    const cands = dict.byFirst.get(tokens[i]!);
    if (!cands) continue;
    for (const e of cands) {
      if (e.n === 1 || tokens.slice(i, i + e.n).join(' ') === e.key) counts.set(e, (counts.get(e) ?? 0) + 1);
    }
  }
  return counts;
}

/** Repeats count with diminishing returns: 1, 1.6, 2, 2.3 ... */
const repeat = (n: number) => 1 + Math.log(n) / Math.log(3) * 0.9;

interface Scored { score: number; terms: Map<string, number> }

function scoreAll(fields: Array<[Field, string[]]>, dicts: Map<string, Dict>): Map<string, Scored> {
  const out = new Map<string, Scored>();
  for (const [id, dict] of dicts) {
    const s: Scored = { score: 0, terms: new Map() };
    for (const [field, tokens] of fields) {
      if (tokens.length === 0) continue;
      for (const [e, n] of matchCounts(tokens, dict)) {
        const pts = e.weight * FIELD_WEIGHT[field] * repeat(n);
        s.score += pts;
        s.terms.set(e.label, (s.terms.get(e.label) ?? 0) + pts);
      }
    }
    if (s.score > 0) out.set(id, s);
  }
  return out;
}

function fieldsOf(p: PageSignals): Array<[Field, string[]]> {
  const clip = (s: string | undefined, n: number) => (s ?? '').slice(0, n);
  const path = clip(p.path, SIGNAL_LIMITS.path).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[/_-]+/g, ' ');
  return [
    ['title', tokenize(clip(p.title, SIGNAL_LIMITS.title))],
    ['description', tokenize(clip(p.description, SIGNAL_LIMITS.description))],
    ['headings', tokenize((p.headings ?? []).slice(0, SIGNAL_LIMITS.headings).map((h) => h.slice(0, SIGNAL_LIMITS.heading)).join(' . '))],
    ['keywords', tokenize((p.keywords ?? []).slice(0, SIGNAL_LIMITS.keywords).map((k) => k.slice(0, SIGNAL_LIMITS.keyword)).join(' . '))],
    ['path', tokenize(path)],
    ['text', tokenize(clip(p.text, SIGNAL_LIMITS.text))],
  ];
}

/** Stable hash of the signals, so an unchanged page is not classified again. */
export function signalsHash(p: PageSignals): string {
  const f = fieldsOf(p).map(([k, t]) => `${k}:${t.join(' ')}`).join('\n');
  return createHash('sha256').update(`${CLASSIFIER_VERSION}\n${(p.lang ?? '').slice(0, SIGNAL_LIMITS.lang).toLowerCase()}\n${f}`).digest('base64url').slice(0, 22);
}

function safetyRisk(score: number): SafetyFlag['risk'] | null {
  if (score >= 6) return 'high';
  if (score >= 3) return 'medium';
  if (score >= 1) return 'low';
  return null;
}

const LEVEL_RANK: Record<PageSafety, number> = { unknown: -1, safe: 0, low: 1, medium: 2, high: 3 };
export function worseSafety(a: PageSafety, b: PageSafety): PageSafety {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

export function classifyPage(p: PageSignals): Classification {
  const hash = signalsHash(p);
  const fields = fieldsOf(p);
  const lang = (p.lang ?? '').toLowerCase();
  const english = lang === '' || lang === 'en' || lang.startsWith('en-') || lang.startsWith('en_');
  const words = fields.reduce((n, [, t]) => n + t.filter((w) => !STOP.has(w)).length, 0);
  const enoughText = english && words >= 5;

  const topicScores = enoughText ? scoreAll(fields.map(([f, t]) => [f, t.filter((w) => !STOP.has(w))] as [Field, string[]]), TOPIC_DICT) : new Map<string, Scored>();
  const ranked = [...topicScores.entries()]
    .filter(([, s]) => s.score >= MIN_TOPIC_SCORE && s.terms.size >= MIN_TOPIC_TERMS)
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  const top = ranked[0]?.[1].score ?? 0;
  const total = [...topicScores.values()].reduce((n, s) => n + s.score, 0) || 1;
  const kept = ranked.filter(([, s]) => s.score >= top * SECONDARY_SHARE).slice(0, MAX_TOPICS);
  const topics: TopicScore[] = kept.map(([id, s]) => ({
    id: id as TopicId,
    score: Math.round(s.score * 10) / 10,
    // Strength of the evidence (saturating) blended with the topic's share of all topic evidence.
    confidence: Math.round(Math.min(1, (s.score / (s.score + 12)) * 0.6 + (s.score / total) * 0.4) * 100) / 100,
  }));

  // Brand safety reads every word, in any language the term lists happen to cover.
  const safetyScores = scoreAll(fields, SAFETY_DICT);
  const primary = topics[0]?.id ?? null;
  const flags: SafetyFlag[] = [];
  for (const [id, s] of safetyScores) {
    let score = s.score;
    // Health pages discuss drugs and addiction as medicine; news pages report crime: count those at half strength.
    if ((id === 'drugs' && primary === 'health') || (id === 'crime_tragedy' && primary === 'news')) score /= 2;
    let risk = safetyRisk(score);
    if (!risk) continue;
    // Gambling is legal content that many advertisers avoid: it never makes a page high risk on its own.
    if (id === 'gambling' && risk === 'high') risk = 'medium';
    flags.push({ category: id as SafetyCategoryId, risk, score: Math.round(score * 10) / 10, terms: topTerms(s.terms, 5) });
  }
  flags.sort((a, b) => b.score - a.score);
  const safety = flags.reduce<SafetyLevel>((lvl, f) => worseSafety(lvl, f.risk) as SafetyLevel, 'safe');

  const termWeights = new Map<string, number>();
  for (const [id] of kept) for (const [t, w] of topicScores.get(id)!.terms) termWeights.set(t, (termWeights.get(t) ?? 0) + w);
  return { version: CLASSIFIER_VERSION, topics, primary, safety, flags, terms: topTerms(termWeights, 12), hash, enoughText };
}

function topTerms(m: Map<string, number>, n: number): string[] {
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([t]) => t);
}
