/**
 * Parser for compose intent URLs.
 *
 * Lets third-party sites and OS share sheets open the Mention composer with
 * prefilled content (e.g. `/intent/compose?text=...&hashtags=foo,bar&url=...`).
 *
 * The parser is pure and side-effect free:
 *  - Unknown keys are silently dropped (logged in __DEV__).
 *  - Invalid values are dropped (graceful), other valid fields kept.
 *  - All URLs are validated via `new URL()` + http/https protocol only.
 *  - HTML is stripped from text fields.
 *
 * Schema (see `docs/INTENT_URL.md`):
 *  text, url, hashtags, via, mentions, replyToPostId, quotePostId, editPostId,
 *  pollOptions, pollDurationDays, articleTitle, articleBody, eventName,
 *  eventDate, eventLocation, eventDescription, lat, lng, address, sources,
 *  scheduledFor, sensitive, replyPermission, quotesDisabled, lang.
 */

/** Hard cap on text length applied after assembly (text + url + tags + via). */
export const MAX_POST_LENGTH = 500;
/** Hard cap on hashtags accepted from intent. */
export const MAX_HASHTAGS = 10;
/** Hard cap on mention handles accepted from intent. */
export const MAX_MENTIONS = 10;
/** Hard cap on sources accepted from intent. Mirrors backend limit. */
export const MAX_SOURCES = 5;
/** Hard cap on poll options accepted from intent. */
export const MAX_POLL_OPTIONS = 4;
/** Minimum poll options accepted from intent. */
export const MIN_POLL_OPTIONS = 2;
/** Min/max poll duration in days. */
export const POLL_DURATION_MIN_DAYS = 1;
export const POLL_DURATION_MAX_DAYS = 7;
export const POLL_DURATION_DEFAULT_DAYS = 7;

const KNOWN_INTENT_KEYS: ReadonlySet<string> = new Set([
  'text',
  'url',
  'hashtags',
  'via',
  'mentions',
  'replyToPostId',
  'quotePostId',
  'editPostId',
  'pollOptions',
  'pollDurationDays',
  'articleTitle',
  'articleBody',
  'eventName',
  'eventDate',
  'eventLocation',
  'eventDescription',
  'lat',
  'lng',
  'address',
  'sources',
  'scheduledFor',
  'sensitive',
  'replyPermission',
  'quotesDisabled',
  'lang',
]);

export type ReplyPermissionIntent = 'anyone' | 'following';

export interface ComposeIntentPollOptions {
  options: string[];
  durationDays: number;
}

export interface ComposeIntentArticle {
  title?: string;
  body?: string;
}

export interface ComposeIntentEvent {
  name?: string;
  /** ISO-8601 date string. */
  date?: string;
  location?: string;
  description?: string;
}

export interface ComposeIntentLocation {
  latitude: number;
  longitude: number;
  address?: string;
}

export interface ComposeIntent {
  text?: string;
  url?: string;
  hashtags?: string[];
  via?: string;
  mentions?: string[];
  replyToPostId?: string;
  quotePostId?: string;
  editPostId?: string;
  poll?: ComposeIntentPollOptions;
  article?: ComposeIntentArticle;
  event?: ComposeIntentEvent;
  location?: ComposeIntentLocation;
  sources?: string[];
  /** ISO-8601 date string. */
  scheduledFor?: string;
  sensitive?: boolean;
  replyPermission?: ReplyPermissionIntent;
  quotesDisabled?: boolean;
  lang?: string;
}

/** Raw shape coming from `useLocalSearchParams` / `URLSearchParams`. */
export type ComposeIntentRawParams = Record<string, string | string[] | undefined>;

const TRUTHY_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);
const HTML_TAG_REGEX = /<[^>]*>/g;
const LEADING_AT_REGEX = /^@+/;

/**
 * Returns the first string for a possibly-array param.
 * `useLocalSearchParams` may return either depending on duplicate keys.
 */
const firstString = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) {
    return value.length > 0 ? value[0] : undefined;
  }
  return value;
};

/** Strip HTML tags from text. Conservative regex — backend re-sanitizes. */
const stripHtml = (value: string): string => value.replace(HTML_TAG_REGEX, '');

/**
 * Sanitize a free-form text field: trim, strip HTML.
 * Returns `undefined` for empty results so callers can skip the field.
 */
const sanitizeText = (raw: string | undefined): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const cleaned = stripHtml(raw).trim();
  return cleaned.length > 0 ? cleaned : undefined;
};

/**
 * Validate a URL: must be a valid http/https URL.
 * Returns the canonical string form, or `undefined` if invalid.
 */
export const validateHttpUrl = (raw: string | undefined): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
};

/** Parse a boolean-ish param (`1`/`true`/`yes`/`on`). */
const parseBool = (raw: string | undefined): boolean | undefined => {
  if (typeof raw !== 'string') return undefined;
  const lower = raw.trim().toLowerCase();
  if (lower.length === 0) return undefined;
  if (TRUTHY_VALUES.has(lower)) return true;
  if (lower === '0' || lower === 'false' || lower === 'no' || lower === 'off') {
    return false;
  }
  return undefined;
};

/** Parse comma-separated values; trims and drops empty entries. */
const parseCommaList = (raw: string | undefined): string[] => {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

/** Parse pipe-separated values; trims and drops empty entries. */
const parsePipeList = (raw: string | undefined): string[] => {
  if (typeof raw !== 'string') return [];
  return raw
    .split('|')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

/**
 * Validate an ISO-8601 date string. Returns the canonical ISO form, or
 * `undefined` if it doesn't parse or isn't in ISO-8601 shape.
 */
export const validateIsoDate = (raw: string | undefined): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  // Cheap shape check first to avoid permissive `new Date("anything")` parsing.
  // Allow dates (YYYY-MM-DD) or full ISO-8601 (YYYY-MM-DDTHH:mm[:ss[.sss]][Z|±HH:mm]).
  const isoLike = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
  if (!isoLike.test(trimmed)) return undefined;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
};

/** Parse a finite number. Returns `undefined` if not numeric. */
const parseFiniteNumber = (raw: string | undefined): number | undefined => {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return undefined;
  return num;
};

/**
 * Normalize a hashtag: lowercase, strip leading `#`s, drop non-tag chars.
 * Returns `undefined` if the resulting tag is empty.
 *
 * Note: we intentionally keep letters, digits, and `_` only — same shape the
 * backend hashtag indexer accepts. Emoji/diacritics are dropped to avoid
 * federation interop drift.
 */
const normalizeHashtag = (raw: string): string | undefined => {
  const lower = raw.toLowerCase().replace(/^#+/, '').trim();
  if (lower.length === 0) return undefined;
  // Keep word chars + unicode letters (BMP). Drop everything else.
  const cleaned = lower.replace(/[^\p{L}\p{N}_]/gu, '');
  return cleaned.length > 0 ? cleaned : undefined;
};

/**
 * Normalize a mention handle: strip leading `@`, lowercase, drop invalid chars.
 * Returns `undefined` if empty.
 */
const normalizeHandle = (raw: string): string | undefined => {
  const cleaned = raw.replace(LEADING_AT_REGEX, '').trim();
  if (cleaned.length === 0) return undefined;
  // Common handle shape: letters, digits, `_`, `-`, `.`.
  const valid = cleaned.replace(/[^a-zA-Z0-9_\-.]/g, '');
  return valid.length > 0 ? valid : undefined;
};

/** Deduplicate preserving order. */
const dedupe = <T,>(items: T[]): T[] => Array.from(new Set(items));

/**
 * Parse a `?text=Hello&hashtags=foo,bar&...` query into a typed `ComposeIntent`.
 *
 * Robust to:
 *  - Unknown keys (logged in dev, dropped).
 *  - Array-valued params (takes first).
 *  - Bad values (drops that one field, keeps the rest).
 */
export const parseComposeIntent = (raw: ComposeIntentRawParams): ComposeIntent => {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    const unknown = Object.keys(raw).filter((key) => !KNOWN_INTENT_KEYS.has(key));
    if (unknown.length > 0) {
      // Lightweight dev signal: third-party callers may be using stale param
      // names. Production builds drop the check entirely (gated by __DEV__).
      console.debug('[composeIntent] dropping unknown keys:', unknown.join(', '));
    }
  }

  const intent: ComposeIntent = {};

  const textValue = sanitizeText(firstString(raw.text));
  if (textValue !== undefined) {
    intent.text = textValue;
  }

  const urlValue = validateHttpUrl(firstString(raw.url));
  if (urlValue !== undefined) {
    intent.url = urlValue;
  }

  const hashtagsRaw = parseCommaList(firstString(raw.hashtags));
  if (hashtagsRaw.length > 0) {
    const normalized = hashtagsRaw
      .map(normalizeHashtag)
      .filter((tag): tag is string => Boolean(tag));
    const deduped = dedupe(normalized).slice(0, MAX_HASHTAGS);
    if (deduped.length > 0) {
      intent.hashtags = deduped;
    }
  }

  const viaRaw = firstString(raw.via);
  if (typeof viaRaw === 'string') {
    const handle = normalizeHandle(viaRaw);
    if (handle) {
      intent.via = handle;
    }
  }

  const mentionsRaw = parseCommaList(firstString(raw.mentions));
  if (mentionsRaw.length > 0) {
    const normalized = mentionsRaw
      .map(normalizeHandle)
      .filter((handle): handle is string => Boolean(handle));
    const deduped = dedupe(normalized).slice(0, MAX_MENTIONS);
    if (deduped.length > 0) {
      intent.mentions = deduped;
    }
  }

  const replyToPostIdValue = sanitizeText(firstString(raw.replyToPostId));
  if (replyToPostIdValue !== undefined) {
    intent.replyToPostId = replyToPostIdValue;
  }

  const quotePostIdValue = sanitizeText(firstString(raw.quotePostId));
  if (quotePostIdValue !== undefined) {
    intent.quotePostId = quotePostIdValue;
  }

  const editPostIdValue = sanitizeText(firstString(raw.editPostId));
  if (editPostIdValue !== undefined) {
    intent.editPostId = editPostIdValue;
  }

  const pollOptionsRaw = parsePipeList(firstString(raw.pollOptions));
  if (pollOptionsRaw.length >= MIN_POLL_OPTIONS) {
    const cleaned = pollOptionsRaw
      .map((opt) => stripHtml(opt).trim())
      .filter((opt) => opt.length > 0)
      .slice(0, MAX_POLL_OPTIONS);
    if (cleaned.length >= MIN_POLL_OPTIONS) {
      const rawDuration = parseFiniteNumber(firstString(raw.pollDurationDays));
      let durationDays = POLL_DURATION_DEFAULT_DAYS;
      if (rawDuration !== undefined) {
        const rounded = Math.round(rawDuration);
        if (rounded >= POLL_DURATION_MIN_DAYS && rounded <= POLL_DURATION_MAX_DAYS) {
          durationDays = rounded;
        }
      }
      intent.poll = { options: cleaned, durationDays };
    }
  }

  const articleTitle = sanitizeText(firstString(raw.articleTitle));
  const articleBody = sanitizeText(firstString(raw.articleBody));
  if (articleTitle !== undefined || articleBody !== undefined) {
    intent.article = {};
    if (articleTitle !== undefined) intent.article.title = articleTitle;
    if (articleBody !== undefined) intent.article.body = articleBody;
  }

  const eventName = sanitizeText(firstString(raw.eventName));
  const eventDate = validateIsoDate(firstString(raw.eventDate));
  const eventLocation = sanitizeText(firstString(raw.eventLocation));
  const eventDescription = sanitizeText(firstString(raw.eventDescription));
  if (
    eventName !== undefined ||
    eventDate !== undefined ||
    eventLocation !== undefined ||
    eventDescription !== undefined
  ) {
    intent.event = {};
    if (eventName !== undefined) intent.event.name = eventName;
    if (eventDate !== undefined) intent.event.date = eventDate;
    if (eventLocation !== undefined) intent.event.location = eventLocation;
    if (eventDescription !== undefined) intent.event.description = eventDescription;
  }

  const lat = parseFiniteNumber(firstString(raw.lat));
  const lng = parseFiniteNumber(firstString(raw.lng));
  const address = sanitizeText(firstString(raw.address));
  if (
    lat !== undefined &&
    lng !== undefined &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  ) {
    intent.location = { latitude: lat, longitude: lng };
    if (address !== undefined) {
      intent.location.address = address;
    }
  }

  const sourcesRaw = parseCommaList(firstString(raw.sources));
  if (sourcesRaw.length > 0) {
    const validated = sourcesRaw
      .map(validateHttpUrl)
      .filter((src): src is string => Boolean(src));
    const deduped = dedupe(validated).slice(0, MAX_SOURCES);
    if (deduped.length > 0) {
      intent.sources = deduped;
    }
  }

  const scheduledForValue = validateIsoDate(firstString(raw.scheduledFor));
  if (scheduledForValue !== undefined) {
    const parsed = new Date(scheduledForValue).getTime();
    if (parsed > Date.now()) {
      intent.scheduledFor = scheduledForValue;
    }
  }

  const sensitiveValue = parseBool(firstString(raw.sensitive));
  if (sensitiveValue !== undefined) {
    intent.sensitive = sensitiveValue;
  }

  const replyPermissionRaw = firstString(raw.replyPermission);
  if (typeof replyPermissionRaw === 'string') {
    const lower = replyPermissionRaw.trim().toLowerCase();
    if (lower === 'anyone' || lower === 'following') {
      intent.replyPermission = lower;
    }
  }

  const quotesDisabledValue = parseBool(firstString(raw.quotesDisabled));
  if (quotesDisabledValue !== undefined) {
    intent.quotesDisabled = quotesDisabledValue;
  }

  const langValue = sanitizeText(firstString(raw.lang));
  if (langValue !== undefined) {
    // BCP-47: language[-script][-region][-variant…]. Cheap shape check.
    const bcp47 = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/;
    if (bcp47.test(langValue)) {
      intent.lang = langValue;
    }
  }

  return intent;
};

/**
 * Build the assembled compose text from the intent.
 *
 * Format: `[@mention1 @mention2 ...] [text] [url] [#tag1 #tag2 ...] [via @handle]`,
 * single-space-joined, clamped to `MAX_POST_LENGTH`. If clamping cuts
 * mid-word, the last token is replaced with an ellipsis.
 *
 * Mentions are prepended as literal `@handle` tokens — the compose mention
 * picker can then resolve them to actual user IDs when the user interacts
 * with the text (we don't have user IDs at parse time).
 */
export const buildComposeText = (intent: ComposeIntent): string => {
  const parts: string[] = [];
  if (intent.mentions && intent.mentions.length > 0) {
    parts.push(intent.mentions.map((handle) => `@${handle}`).join(' '));
  }
  if (intent.text) parts.push(intent.text);
  if (intent.url) parts.push(intent.url);
  if (intent.hashtags && intent.hashtags.length > 0) {
    parts.push(intent.hashtags.map((tag) => `#${tag}`).join(' '));
  }
  if (intent.via) parts.push(`via @${intent.via}`);

  const joined = parts.join(' ').trim();
  if (joined.length <= MAX_POST_LENGTH) return joined;

  // Clamp at word boundary, append ellipsis.
  const clamped = joined.slice(0, MAX_POST_LENGTH);
  const lastSpace = clamped.lastIndexOf(' ');
  if (lastSpace > 0 && lastSpace >= MAX_POST_LENGTH - 40) {
    return `${clamped.slice(0, lastSpace).trimEnd()}…`;
  }
  // Fall back to hard truncate with ellipsis.
  return `${clamped.slice(0, MAX_POST_LENGTH - 1).trimEnd()}…`;
};

/**
 * Whether the intent carries any value worth applying to the composer.
 * Used by the compose screen to skip the draft-conflict prompt when the
 * intent is empty (e.g. a user just opened `/intent/compose` directly).
 */
export const hasIntentContent = (intent: ComposeIntent): boolean => {
  return Boolean(
    intent.text ||
      intent.url ||
      (intent.hashtags && intent.hashtags.length > 0) ||
      intent.via ||
      (intent.mentions && intent.mentions.length > 0) ||
      intent.replyToPostId ||
      intent.quotePostId ||
      intent.editPostId ||
      intent.poll ||
      intent.article ||
      intent.event ||
      intent.location ||
      (intent.sources && intent.sources.length > 0) ||
      intent.scheduledFor ||
      intent.sensitive !== undefined ||
      intent.replyPermission ||
      intent.quotesDisabled !== undefined ||
      intent.lang,
  );
};

/**
 * Build the fallback URL for a quote post when the live fetch fails.
 * Mirrors `hooks/usePostShare.ts` format.
 */
export const buildQuoteFallbackUrl = (postId: string): string =>
  `https://mention.earth/p/${postId}`;
