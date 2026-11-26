/**
 * Deterministic BOT-SHAPE detection for the Stage-A baseline classifier.
 *
 * Two independent signals, both pure and synchronous:
 *   - `isRssMirror` — the post came from an AUTOMATED account: a federated actor
 *     whose AP `type` is `Service`/`Application`, or whose instance host looks
 *     like an RSS/bridge mirror (`rss-…`, `rss.…`, `bot.…`, or contains
 *     `bridge`). Requires a known federated origin; a native post is never a
 *     mirror.
 *   - `isLinkOnlyNewsBot` — the TEXT SHAPE of a headline-mirror: a leading (or
 *     sole) link followed by a boilerplate hashtag tail, with little/no original
 *     prose. This works from the text alone (defense-in-depth), so it still fires
 *     when actor metadata is unavailable.
 *
 * Both feed the deterministic spam score in {@link ./spamQuality}; the RSS-mirror
 * and link-only signals are weighted so that a post carrying BOTH clears the
 * ranking safety spam threshold and is pushed out of discovery.
 */

/**
 * The federated-origin context the bot heuristics read. All optional and
 * additive: a native or unknown-origin caller passes nothing and every signal is
 * `false`.
 */
export interface BotSignalContext {
  /** AP actor type (`Person`/`Service`/`Application`/…), when the post is federated. */
  actorType?: string;
  /** Federated instance host (e.g. `rss-mstdn.example`), when known. */
  instanceDomain?: string;
  /** Whether the post originated from a federated instance. */
  isFederated?: boolean;
}

/**
 * The text features the bot heuristics read — a structural subset of the
 * `TextFeatures` that {@link ./spamQuality} already parses, so the caller passes
 * that object directly (no re-parse).
 */
export interface BotShapeFeatures {
  /** The raw, unmodified post text. */
  rawText: string;
  /** Visible prose with URLs, hashtags, and mentions stripped (already trimmed). */
  visible: string;
  /** Number of URLs in the text. */
  urlCount: number;
  /** Number of canonical hashtags on the post. */
  hashtagCount: number;
}

/** The bot thresholds/hosts this detector reads — a subset of `SPAM_QUALITY_CONFIG.bot`. */
export interface BotConfig {
  /** instanceDomain prefixes that mark an RSS/bot mirror instance. */
  rssHostPrefixes: readonly string[];
  /** instanceDomain substrings that mark a bridge/mirror instance. */
  rssHostContains: readonly string[];
  /** Hashtag count at/above which a trailing hashtag block reads as boilerplate. */
  boilerplateHashtagTailThreshold: number;
  /** Max visible-prose length for a leading-link + hashtag post to still count as a link-only bot. */
  linkOnlyNewsBotMaxProseLength: number;
}

/** Result of {@link detectBotShape}. */
export interface BotShapeResult {
  /** The post came from an automated (RSS/bot/bridge/Service/Application) account. */
  isRssMirror: boolean;
  /** The post has the link-only news-bot text shape (leading link + boilerplate hashtag tail). */
  isLinkOnlyNewsBot: boolean;
}

/** AP actor types that denote an automated (non-human) account. */
const AUTOMATED_ACTOR_TYPES: readonly string[] = ['Service', 'Application'];

/** A URL at the very start of the (leading-whitespace-trimmed) text. No `/g/` flag → safe for `.test()`. */
const LEADING_URL_PATTERN = /^https?:\/\//i;

/**
 * Detect the RSS/bot-mirror and link-only news-bot shapes of a post. Pure: no DB,
 * no network, no mutation.
 */
export function detectBotShape(
  features: BotShapeFeatures,
  ctx: BotSignalContext,
  cfg: BotConfig,
): BotShapeResult {
  return {
    isRssMirror: detectRssMirror(ctx, cfg),
    isLinkOnlyNewsBot: detectLinkOnlyNewsBot(features, cfg),
  };
}

/**
 * An RSS/bot mirror is a KNOWN-federated account that is either declared
 * automated (AP `type` Service/Application) or hosted on a mirror-shaped instance
 * (host prefix `rss-`/`rss.`/`bot.`, or containing `bridge`). Native posts (no
 * federated origin) are never mirrors.
 */
function detectRssMirror(ctx: BotSignalContext, cfg: BotConfig): boolean {
  if (!ctx.isFederated) {
    return false;
  }
  if (ctx.actorType && AUTOMATED_ACTOR_TYPES.includes(ctx.actorType)) {
    return true;
  }
  const domain = ctx.instanceDomain?.toLowerCase();
  if (!domain) {
    return false;
  }
  if (cfg.rssHostPrefixes.some((prefix) => domain.startsWith(prefix))) {
    return true;
  }
  return cfg.rssHostContains.some((fragment) => domain.includes(fragment));
}

/**
 * The link-only news-bot text shape: a leading (or sole) URL, a boilerplate
 * hashtag tail (hashtag count at/above the threshold), and sub-threshold original
 * prose. Requiring a LEADING/only URL (not just any URL) keeps a normal post that
 * merely embeds a link — with real writing before it — from being misread as a
 * bot. Derived purely from text, so it holds even without actor metadata.
 */
function detectLinkOnlyNewsBot(features: BotShapeFeatures, cfg: BotConfig): boolean {
  if (features.urlCount === 0) {
    return false;
  }
  const startsWithUrl = LEADING_URL_PATTERN.test(features.rawText.trimStart());
  const proseLength = features.visible.length;
  const hasLeadingOrOnlyUrl = startsWithUrl || proseLength === 0;
  const hasBoilerplateHashtagTail = features.hashtagCount >= cfg.boilerplateHashtagTailThreshold;
  const hasSubThresholdProse = proseLength <= cfg.linkOnlyNewsBotMaxProseLength;
  return hasLeadingOrOnlyUrl && hasBoilerplateHashtagTail && hasSubThresholdProse;
}
