/**
 * Deterministic content-classification taxonomy and lookup maps for the
 * Stage-A baseline classifier ({@link ../BaselineContentClassifier}).
 *
 * Everything here is plain data so the rules are auditable, testable, and
 * cheap to evolve. Topic slugs are intentionally aligned with the canonical
 * topic registry's known categories (TopicService `KNOWN_CATEGORIES`) so that
 * Stage-A rule topics resolve to the SAME Topic documents the async AI step and
 * trending/personalization use — there is one canonical topic vocabulary.
 */

/**
 * Canonical Stage-A topic slugs. A curated superset of the topic registry's
 * known categories plus a few high-signal sub-slugs the rule layer can emit.
 * Anything the rules produce MUST be a member of this set so downstream
 * reconciliation (P3) has a fixed, known vocabulary.
 */
export const TOPIC_SLUGS = [
  'tech',
  'ai',
  'science',
  'news',
  'politics',
  'business',
  'finance',
  'art',
  'design',
  'photography',
  'music',
  'gaming',
  'sports',
  'food',
  'travel',
  'fashion',
  'health',
  'lgbtq',
  'memes',
  'education',
  'entertainment',
] as const;

export type TopicSlug = (typeof TOPIC_SLUGS)[number];

const TOPIC_SLUG_SET: ReadonlySet<string> = new Set(TOPIC_SLUGS);

/** Type guard: whether an arbitrary string is a known canonical topic slug. */
export function isTopicSlug(value: string): value is TopicSlug {
  return TOPIC_SLUG_SET.has(value);
}

/**
 * Hashtag alias map: normalized hashtag (lowercase, no `#`) → canonical
 * hashtag. Collapses common spelling/variant forms onto one canonical token so
 * `hashtagsNorm` is stable for discovery and so hashtag-driven topic rules only
 * need to match the canonical form. Data-driven and easily extended.
 *
 * The KEY is an already-normalized hashtag; the VALUE is the canonical hashtag
 * (NOT necessarily a topic slug — topic mapping is a separate step).
 */
export const HASHTAG_ALIASES: Readonly<Record<string, string>> = {
  artificialintelligence: 'ai',
  machinelearning: 'ai',
  ml: 'ai',
  deeplearning: 'ai',
  genai: 'ai',
  generativeai: 'ai',
  llm: 'ai',
  llms: 'ai',
  chatgpt: 'ai',
  openai: 'ai',
  neuralnetwork: 'ai',
  neuralnetworks: 'ai',
  technology: 'tech',
  technews: 'tech',
  programming: 'tech',
  coding: 'tech',
  developer: 'tech',
  devops: 'tech',
  softwaredevelopment: 'tech',
  softwareengineering: 'tech',
  webdev: 'tech',
  webdevelopment: 'tech',
  javascript: 'tech',
  typescript: 'tech',
  python: 'tech',
  opensource: 'tech',
  cybersecurity: 'tech',
  cloudcomputing: 'tech',
  crypto: 'finance',
  cryptocurrency: 'finance',
  bitcoin: 'finance',
  ethereum: 'finance',
  investing: 'finance',
  investment: 'finance',
  stocks: 'finance',
  stockmarket: 'finance',
  trading: 'finance',
  personalfinance: 'finance',
  startup: 'business',
  startups: 'business',
  entrepreneur: 'business',
  entrepreneurship: 'business',
  marketing: 'business',
  smallbusiness: 'business',
  ecommerce: 'business',
  leadership: 'business',
  photo: 'photography',
  photos: 'photography',
  photographer: 'photography',
  photooftheday: 'photography',
  streetphotography: 'photography',
  videogames: 'gaming',
  videogame: 'gaming',
  gamer: 'gaming',
  gaming: 'gaming',
  esports: 'gaming',
  twitch: 'gaming',
  football: 'sports',
  soccer: 'sports',
  basketball: 'sports',
  baseball: 'sports',
  tennis: 'sports',
  nba: 'sports',
  nfl: 'sports',
  mlb: 'sports',
  formula1: 'sports',
  f1: 'sports',
  foodie: 'food',
  cooking: 'food',
  recipe: 'food',
  recipes: 'food',
  baking: 'food',
  vegan: 'food',
  coffee: 'food',
  traveling: 'travel',
  travelling: 'travel',
  travelphotography: 'travel',
  wanderlust: 'travel',
  backpacking: 'travel',
  adventure: 'travel',
  style: 'fashion',
  ootd: 'fashion',
  streetwear: 'fashion',
  fashionweek: 'fashion',
  wellness: 'health',
  fitness: 'health',
  workout: 'health',
  mentalhealth: 'health',
  meditation: 'health',
  yoga: 'health',
  nutrition: 'health',
  pride: 'lgbtq',
  lgbt: 'lgbtq',
  lgbtqia: 'lgbtq',
  queer: 'lgbtq',
  transgender: 'lgbtq',
  meme: 'memes',
  memes: 'memes',
  shitpost: 'memes',
  funny: 'memes',
  learning: 'education',
  edu: 'education',
  studytwt: 'education',
  onlinelearning: 'education',
  movies: 'entertainment',
  movie: 'entertainment',
  film: 'entertainment',
  cinema: 'entertainment',
  tv: 'entertainment',
  tvshow: 'entertainment',
  netflix: 'entertainment',
  streaming: 'entertainment',
  celebrity: 'entertainment',
  music: 'music',
  newmusic: 'music',
  hiphop: 'music',
  spotify: 'music',
  livemusic: 'music',
  science: 'science',
  space: 'science',
  astronomy: 'science',
  physics: 'science',
  biology: 'science',
  climate: 'science',
  climatechange: 'science',
  news: 'news',
  breakingnews: 'news',
  worldnews: 'news',
  politics: 'politics',
  election: 'politics',
  elections: 'politics',
  art: 'art',
  artist: 'art',
  digitalart: 'art',
  illustration: 'art',
  drawing: 'art',
  painting: 'art',
  design: 'design',
  graphicdesign: 'design',
  uxdesign: 'design',
  uidesign: 'design',
  productdesign: 'design',
} as const;

/**
 * Map of canonical hashtag → topic slug. After hashtag normalization +
 * aliasing, a hashtag that appears here contributes its topic slug. Keys are
 * canonical hashtags (post-alias). Only includes mappings that are
 * unambiguous; ambiguous tags are left to keyword rules or omitted.
 */
export const HASHTAG_TOPIC_MAP: Readonly<Record<string, TopicSlug>> = {
  ai: 'ai',
  tech: 'tech',
  science: 'science',
  news: 'news',
  politics: 'politics',
  business: 'business',
  finance: 'finance',
  art: 'art',
  design: 'design',
  photography: 'photography',
  music: 'music',
  gaming: 'gaming',
  sports: 'sports',
  food: 'food',
  travel: 'travel',
  fashion: 'fashion',
  health: 'health',
  lgbtq: 'lgbtq',
  memes: 'memes',
  education: 'education',
  entertainment: 'entertainment',
} as const;

/**
 * Keyword → topic slug rules applied to lowercased post text. Each entry lists
 * whole-word keywords/phrases that map to a topic slug. Matching is
 * whole-word/phrase (word boundaries) and case-insensitive so substrings like
 * "scart" never trip "art". Keep keywords specific to avoid false positives.
 */
export const KEYWORD_TOPIC_RULES: ReadonlyArray<{ topic: TopicSlug; keywords: readonly string[] }> = [
  { topic: 'ai', keywords: ['artificial intelligence', 'machine learning', 'neural network', 'chatgpt', 'large language model', 'deep learning', 'generative ai', 'prompt engineering', 'transformer model'] },
  { topic: 'tech', keywords: ['javascript', 'typescript', 'kubernetes', 'open source', 'software', 'database', 'api', 'cybersecurity', 'cloud computing', 'data center', 'developer tools', 'source code'] },
  { topic: 'science', keywords: ['physics', 'biology', 'chemistry', 'astronomy', 'research paper', 'experiment', 'climate change', 'quantum', 'genetics', 'telescope', 'peer reviewed'] },
  { topic: 'news', keywords: ['breaking news', 'headline', 'press release', 'developing story', 'live updates'] },
  { topic: 'politics', keywords: ['election', 'parliament', 'senate', 'congress', 'policy', 'legislation', 'campaign trail', 'supreme court', 'prime minister', 'foreign policy'] },
  { topic: 'business', keywords: ['startup', 'funding round', 'acquisition', 'revenue', 'venture capital', 'series a', 'ipo', 'product launch', 'go to market', 'small business'] },
  { topic: 'finance', keywords: ['stock market', 'inflation', 'interest rate', 'cryptocurrency', 'bitcoin', 'portfolio', 'ethereum', 'federal reserve', 'dividend', 'hedge fund', 'recession'] },
  { topic: 'art', keywords: ['painting', 'sculpture', 'illustration', 'gallery', 'artwork', 'digital art', 'watercolor', 'art exhibition'] },
  { topic: 'design', keywords: ['ux design', 'ui design', 'typography', 'product design', 'figma', 'graphic design', 'design system', 'wireframe', 'prototype'] },
  { topic: 'photography', keywords: ['photography', 'photographer', 'camera lens', 'long exposure', 'street photography', 'portrait photography', 'shutter speed'] },
  { topic: 'music', keywords: ['album', 'concert', 'spotify', 'songwriter', 'playlist', 'new single', 'music video', 'hip hop', 'live show', 'tour dates'] },
  { topic: 'gaming', keywords: ['video game', 'gameplay', 'playstation', 'xbox', 'nintendo', 'esports', 'speedrun', 'game studio', 'open world', 'multiplayer'] },
  { topic: 'sports', keywords: ['football', 'basketball', 'tennis', 'marathon', 'world cup', 'championship', 'playoffs', 'transfer window', 'grand slam', 'olympics', 'formula 1'] },
  { topic: 'food', keywords: ['recipe', 'restaurant', 'cooking', 'baking', 'cuisine', 'home cooking', 'meal prep', 'street food', 'tasting menu'] },
  { topic: 'travel', keywords: ['vacation', 'flight booking', 'backpacking', 'itinerary', 'road trip', 'travel guide', 'digital nomad', 'hidden gem', 'layover'] },
  { topic: 'fashion', keywords: ['runway', 'streetwear', 'wardrobe', 'haute couture', 'fashion week', 'capsule wardrobe', 'thrift haul'] },
  { topic: 'health', keywords: ['nutrition', 'workout', 'mental health', 'meditation', 'wellbeing', 'strength training', 'mindfulness', 'sleep hygiene', 'gut health'] },
  { topic: 'lgbtq', keywords: ['pride month', 'transgender', 'nonbinary', 'coming out', 'same sex marriage', 'gender identity'] },
  { topic: 'education', keywords: ['university', 'curriculum', 'scholarship', 'online course', 'tutorial', 'study guide', 'student loan', 'lecture notes', 'phd'] },
  { topic: 'entertainment', keywords: ['box office', 'tv series', 'streaming series', 'red carpet', 'season finale', 'trailer drop', 'celebrity', 'award show'] },
];

/**
 * Best-effort federated-instance/TLD → coarse region code map. Used ONLY for
 * federated posts where we know the instance domain. Deliberately conservative:
 * popular global instances stay `undefined` (no meaningful region), country-code
 * TLDs and a few well-known national instances map to an uppercase ISO 3166-1
 * alpha-2 code. Never inferred from post text.
 *
 * Keys are matched in two passes: (1) exact full instance host, then
 * (2) the host's effective TLD suffix (e.g. `.de`).
 */
export const INSTANCE_REGION_MAP: Readonly<Record<string, string>> = {
  // Well-known national instances whose generic TLD hides their region.
  'mstdn.jp': 'JP',
  'pawoo.net': 'JP',
  'mastodon.uno': 'IT',
  'mas.to': '', // intentionally global: no region
  'mastodon.social': '', // global flagship
  'mastodon.online': '',
};

/**
 * Country-code TLD → ISO 3166-1 alpha-2 region. A small, high-confidence subset.
 * Generic TLDs (`.com`, `.org`, `.net`, `.social`, etc.) are intentionally
 * absent → region stays `undefined`.
 */
export const TLD_REGION_MAP: Readonly<Record<string, string>> = {
  de: 'DE',
  fr: 'FR',
  es: 'ES',
  it: 'IT',
  nl: 'NL',
  jp: 'JP',
  uk: 'GB',
  ca: 'CA',
  au: 'AU',
  br: 'BR',
  pt: 'PT',
  pl: 'PL',
  se: 'SE',
  no: 'NO',
  fi: 'FI',
  ie: 'IE',
  at: 'AT',
  ch: 'CH',
  be: 'BE',
  mx: 'MX',
  ar: 'AR',
  cl: 'CL',
  co: 'CO',
  in: 'IN',
};
