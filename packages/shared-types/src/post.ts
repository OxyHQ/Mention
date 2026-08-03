/**
 * Post-related types for Mention social network
 */

import type { AccountKind, UserNameResponse } from '@oxyhq/contracts';
import { GeoJSONPoint } from './common';
import type { LaneSummary } from './lane';

export enum PostType {
  TEXT = 'text',
  IMAGE = 'image',
  VIDEO = 'video',
  POLL = 'poll',
  BOOST = 'boost',
  QUOTE = 'quote'
}

export enum PostVisibility {
  PUBLIC = 'public',
  FOLLOWERS_ONLY = 'followers_only',
  PRIVATE = 'private'
}

/**
 * Oxy asset IMAGE variant names that the central asset service actually
 * generates (`packages/api/src/services/variantService.ts` `imageVariants`):
 * `w96` / `w128` / `thumb`(256) / `w320` / `w640` / `w1280` / `w2048` — all
 * named for their pixel width except the legacy `thumb` (also 256px,
 * predates the width-naming convention). `small`/`medium`/`large`/`original`/
 * `avatar` do NOT exist server-side and 404 on the CDN (`avatar` was `w128`'s
 * name for its first few hours before being renamed to match convention —
 * these are generic small-image sizes, not avatar-specific, so other
 * small-image contexts can reach for them too).
 *
 * These are the SINGLE source of truth for which variant each render context
 * requests, shared by the backend resolver (`utils/mediaResolver.ts`) and the
 * frontend (post media card / lightbox fallback) so the server-resolved and
 * client-fallback URL paths always agree.
 *
 * The in-feed post media card (~135–320px wide) and the profile media grid
 * (~190px cells) are both ≤320px, so the THUMB context maps to `w320` — large
 * enough for a retina render of those small surfaces, but far lighter than the
 * `w640`/`w1280`/`w2048` variants reserved for wider displays / the lightbox.
 *
 * Avatars render small and circular, so the AVATAR context maps to the
 * dedicated 96px square `w96` crop — most avatars across the app render
 * ≤40px (post headers ~36px, notifications, facepiles), so `w96` covers
 * those comfortably even at 3x DPR while staying lighter than the 128px
 * crop it replaced. A handful of surfaces render a MUCH bigger avatar —
 * the profile header (90px / 70px), the about page (80px), the OAuth consent
 * screens (72px / 56px), starter-pack and list avatar groups (56px) — where
 * `w96` would be visibly soft at 3x DPR; AVATAR_LG covers those with the 256px
 * `thumb` crop. Those call sites previously reached for VIDEO_POSTER purely
 * because it happened to equal `'thumb'`, which made every one of them read as
 * if it were rendering a video.
 *
 * VIDEO posters are two contexts, not one, and a single size cannot serve both:
 *  - VIDEO_THUMB (`w320`) is a small STILL — the profile media grid cell and
 *    the notification thumbnail. It matches THUMB exactly, so a video cell and
 *    an image cell in the same grid now cost the same.
 *  - VIDEO_POSTER (`w1280`) is the frame shown BEHIND a player, and both of its
 *    surfaces are full-width: the in-feed video card and the fullscreen Reels
 *    viewer. On a 3x-DPR phone that is ~1180 device px, so the two differ by
 *    padding, not by an order of magnitude. `w1280` covers both; `w2048` would
 *    add rows neither can show.
 * The previous single `'thumb'` (256px) was wrong at BOTH ends — it yielded
 * 144x256 for a 720x1280 source, too soft fullscreen, while the only other
 * working option (the raw `poster`, up to 1920px / ~240 KB) was ~6x oversized
 * for a grid cell.
 *
 * The profile banner is its own context: a full-bleed 170px-tall strip, so its
 * width — not the lightbox's — is what bounds it. The widest real surface is a
 * 3x-DPR phone (~430pt ⇒ ~1290 device px); the framed web panel is far narrower.
 * BANNER therefore maps to `w1280` rather than reusing FULL: at that height the
 * extra rows in `w2048` are invisible while costing ~1.5x the bytes, and the raw
 * no-variant original costs ~15x (measured on a live banner: 2.66 MB PNG
 * original / 270 KB `w2048` / 179 KB `w1280`).
 */
export const MEDIA_VARIANT_THUMB = 'w320';
export const MEDIA_VARIANT_FULL = 'w2048';
export const MEDIA_VARIANT_AVATAR = 'w96';
export const MEDIA_VARIANT_AVATAR_LG = 'thumb';
export const MEDIA_VARIANT_VIDEO_THUMB = 'w320';
export const MEDIA_VARIANT_VIDEO_POSTER = 'w1280';
export const MEDIA_VARIANT_BANNER = 'w1280';

export interface MediaItem {
  id: string;
  type: 'image' | 'video' | 'gif';
  /**
   * Accessibility description (alt text) for images, authored by the post creator
   * (Bluesky-style "ALT" feature). Optional passthrough — stored on the post and
   * returned in the DTO so the client can render the description and an "ALT"
   * badge. Not a URL; never resolved/rewritten.
   */
  alt?: string;
  /** Intrinsic pixel width when known (persisted at ingest from Oxy or AP). */
  width?: number;
  /** Intrinsic pixel height when known (persisted at ingest from Oxy or AP). */
  height?: number;
  /** Playback duration in seconds for video (and animated gif when detected). */
  durationSec?: number;
  /** Byte size when known (Oxy asset or federated cache). */
  sizeBytes?: number;
  /** Derived at ingest from width/height (Oxy canonical; AP pre-cache until Oxy wins). */
  orientation?: 'portrait' | 'landscape' | 'square';
  /** width / height, set at ingest together with orientation. */
  aspectRatio?: number;
  /** MIME type when known at ingest. */
  mime?: string;
  /** Original remote URL when federated media was cached to an Oxy file id. */
  remoteUrl?: string;
  /** True when this item's id was rewritten from a remote URL to an Oxy asset. */
  cachedFromFederation?: boolean;
  /**
   * Final, ready-to-render media URL resolved server-side (CDN or our media
   * proxy). Backends populate this so the frontend never computes URLs from `id`.
   */
  url?: string;
  /** Final, ready-to-render thumbnail URL (smaller variant) when available. */
  thumbUrl?: string;
  /**
   * Final, ready-to-render poster/still-frame URL for videos. For images this
   * mirrors `thumbUrl`.
   */
  posterUrl?: string;
  /**
   * Final, ready-to-render LARGE display URL for the fullscreen image viewer
   * (lightbox), when a large variant can be derived. Sized for the on-open
   * upgrade, not the raw original. Only present for native Oxy images;
   * federated/proxied media has no variant system, so this is omitted and the
   * viewer falls back to `url`.
   */
  fullUrl?: string;
  /**
   * Adaptive-bitrate HLS master playlist URL for native (non-federated) videos,
   * when the background transcode has produced one. `expo-video` (AVPlayer on
   * iOS, ExoPlayer on Android) plays an `.m3u8` URL natively and switches
   * quality automatically based on network conditions — no extra client code
   * needed beyond preferring this URL over `url`.
   *
   * NOT guaranteed to be ready: variant generation is fire-and-forget on
   * upload (see `OxyHQServices/packages/api/src/services/assetService.ts`
   * `queueVariantGeneration`), so a just-uploaded video's HLS ladder may not
   * exist yet — requesting it can 404/500. Consumers MUST fall back to `url`
   * (the raw original, always playable) on a playback error; never treat
   * `hlsUrl` as authoritative on its own. Omitted for federated/proxied video
   * (no Oxy variant system exists for those).
   */
  hlsUrl?: string;
}

export type PostAttachmentType = 'media' | 'poll' | 'article' | 'location' | 'sources' | 'event' | 'room' | 'podcast';

export interface PostAttachmentDescriptor {
  type: PostAttachmentType;
  id?: string; // For media attachments and other id-referenced attachments
  mediaType?: 'image' | 'video' | 'gif';
}

export interface PostSourceLink {
  url: string;
  title?: string;
}

export interface PostArticleContent {
  articleId?: string;
  title?: string;
  body?: string;
  excerpt?: string;
}

export interface PostEventContent {
  eventId?: string;
  name: string;
  date: string; // ISO date string
  location?: string;
  description?: string;
}

export interface PostRoomContent {
  roomId: string;
  title: string;
  status?: 'scheduled' | 'live' | 'ended';
  topic?: string;
  host?: string;
}

/**
 * A Syra podcast SHOW attached to a post (or pinned on a profile). The metadata
 * is denormalized server-side from the Syra catalog (via @syra.fm/sdk getPodcast)
 * at write time — never trusted from the client. The card opens the show in Syra
 * via `showUrl`.
 */
export interface PostPodcastContent {
  syraPodcastId: string;
  title: string;
  author?: string;
  artworkUrl?: string;
  showUrl: string;
}

/**
 * What a CLIENT sends when attaching a podcast: only the Syra show id. The
 * server resolves + denormalizes the rest (title/author/artwork/showUrl) via
 * @syra.fm/sdk, so the client never supplies — and is never trusted for — them.
 */
export interface PostPodcastInput {
  syraPodcastId: string;
}

/**
 * Where a localized rendition came from.
 *
 * The distinction is load-bearing, not decorative: only `author` variants
 * declare the post's languages (classification, ranking, federation) and only
 * they are signed onto the author's MTN chain. A machine translation is DERIVED
 * content — signing it into the author's record would attribute to them words
 * they never wrote.
 */
export type PostVariantSource = 'author' | 'machine';

/**
 * ONE localized rendition of a post.
 *
 * **A variant INHERITS everything it does not override.** That is the whole rule:
 *
 * - `media` absent → the variant shows `content.media` (the same images). It may
 *   still localize their descriptions through `alt`.
 * - `media` present → it REPLACES the media set outright (a different infographic
 *   per language). Each {@link MediaItem} already carries its own `alt`, so the
 *   `alt` map is meaningless here — the two are mutually exclusive, and supplying
 *   both is rejected at the boundary. Two sources of truth for one alt text is
 *   exactly the ambiguity this forbids.
 * - `article` absent → the variant shows `content.article`.
 *
 * `tag` is a canonical BCP-47 tag (`es-ES`); it is never a bare string from a
 * client — see `canonicalizeLanguageTag`.
 */
export interface PostContentVariant {
  /**
   * Canonical BCP-47 tag (`es-ES`).
   *
   * ABSENT when the post has no resolvable language — a body too short to detect
   * ("ok", "+1", a bare URL), or a federated Note that declares none. That is a
   * real state and the schema says so rather than inventing a tag: minting one
   * from a detector's best guess would stamp a wrong language on the post and
   * then federate that lie in `contentMap` / `language`. At most ONE variant may
   * be untagged, and it is the primary.
   */
  tag?: string;
  source: PostVariantSource;
  text: string;
  /** Localized alt text for the SHARED media set, keyed by media id. */
  alt?: Record<string, string>;
  /** Replaces the media set for this language entirely. */
  media?: MediaItem[];
  /** Localized long-form. `articleId` is NOT duplicated — it is the same entity. */
  article?: Pick<PostArticleContent, 'title' | 'body' | 'excerpt'>;
  createdAt?: string;
}

/**
 * A post's content AS STORED.
 *
 * The renditions are the only home for text: there is no top-level `text`
 * field, because every variant necessarily has its own body, so a body at the
 * top would necessarily be a copy of one of them. `media` and `article`, by
 * contrast, are genuinely SHARED — most posts have one media set that every
 * language uses — so they live once, at the top, and a variant overrides them
 * only when it actually differs. Pushing them into every variant would not
 * remove duplication; it would create it.
 *
 * **`variants[0]` is the primary.** It is the rendition that federates, that is
 * signed onto the chain, and that a reader falls back to. There is no separate
 * `primaryTag` field: that would just be a copy of `variants[0].tag`. Read it
 * through the resolver, never by indexing the array by hand.
 *
 * `poll`, `location` and `sources` are deliberately NOT per-variant: they are
 * facts about the post, not about a language (a poll especially — its votes must
 * aggregate; two polls would split the count).
 */
export interface StoredPostContent {
  variants?: PostContentVariant[];
  media?: MediaItem[];
  article?: PostArticleContent;
  poll?: PollData;
  pollId?: string;
  location?: GeoJSONPoint;
  sources?: PostSourceLink[];
  event?: PostEventContent;
  room?: PostRoomContent;
  podcast?: PostPodcastContent;
  attachments?: PostAttachmentDescriptor[];
}

/**
 * A post's content AS SERVED to a client — the RESOLVED view of
 * {@link StoredPostContent} for one particular reader.
 *
 * This is deliberately a different shape from what is stored. The server picks
 * the variant that fits the viewer and flattens it into `text` / `media` /
 * `article`, so every renderer keeps reading `content.text` and is simply
 * correct — the feed, the post detail, video captions, notification previews,
 * quote cards, share sheets, OG cards and MCP all get the right language without
 * knowing this feature exists. Resolving on the client instead would mean
 * teaching each of them the same lesson, and the one that forgot would silently
 * show the wrong language.
 *
 * A client also SENDS this shape when composing: `text` is then the primary
 * body, and the server turns it into the primary variant. That is an API
 * convenience, not storage — nothing keeps a second copy of the body on disk.
 */
export interface PostContent {
  /** The body, already resolved for this reader (or the primary body on write). */
  text?: string;
  /**
   * The renditions the reader can actually switch to: every AUTHOR variant, plus
   * the machine translation for their own language when one already exists.
   * `source` says which is which — there is no second list.
   *
   * Deliberately NOT a catalogue of every cached translation. Which languages
   * happen to sit in the machine cache is the SERVER's business: a client asks
   * "translate this to German" and the server decides whether that costs a
   * cache read or an inference call. Publishing the cache's contents would leak
   * an implementation detail into the API and invite clients to treat the cache
   * as the menu of what's possible — when in fact any language is.
   */
  variants?: PostContentVariant[];
  /** Media, with this reader's localized alt text already merged in. */
  media?: MediaItem[];
  poll?: PollData; // Populated poll data for display
  pollId?: string; // Reference to poll document
  location?: GeoJSONPoint; // Location shared by user as part of post content
  sources?: PostSourceLink[]; // External sources cited within the post content
  article?: PostArticleContent; // Long-form, resolved for this reader
  event?: PostEventContent; // Optional event content
  room?: PostRoomContent; // Optional room content
  podcast?: PostPodcastContent; // Optional Syra podcast show attached to the post
  attachments?: PostAttachmentDescriptor[]; // Ordered attachments for rendering (media, poll, article, event, etc.)
  /**
   * The tag actually served in `text` — what the UI shows as "Showing in
   * Spanish". Absent when the post has no resolvable language.
   */
  textLang?: string;
}

/**
 * Content shape a CLIENT submits when creating a post. Identical to
 * {@link PostContent} except `podcast` carries only the id ({@link PostPodcastInput});
 * the server denormalizes the full show metadata before persisting.
 */
export type PostContentInput = Omit<PostContent, 'podcast'> & {
  podcast?: PostPodcastInput;
};

export interface PollData {
  question: string;
  options: string[];
  endTime: string;
  votes: Record<string, number>; // option index -> vote count
  userVotes: Record<string, string>; // userId -> option index
}

export type ReplyPermission = 'anyone' | 'followers' | 'following' | 'mentioned' | 'nobody';

/**
 * Sentiment inferred from a post's content. `mixed` covers posts that are
 * simultaneously positive and negative (e.g. constructive criticism).
 */
export type PostSentiment = 'positive' | 'neutral' | 'negative' | 'mixed';

/**
 * High-level communicative intent inferred from a post's content. `other` is the
 * catch-all when no specific intent applies.
 */
export type PostIntent =
  | 'question'
  | 'announcement'
  | 'feedback'
  | 'opinion'
  | 'complaint'
  | 'joke'
  | 'news'
  | 'personal_update'
  | 'other';

/**
 * Quality / safety / ranking signals inferred from a post's content. Every score
 * is a normalized probability in the inclusive range 0..1.
 *
 * These are deliberately orthogonal so ranking can combine them without
 * re-parsing content — e.g. negative-but-constructive posts (high
 * `constructiveness`, low `toxicity`) stay eligible while toxic/ragebait posts
 * (high `toxicity`, low `constructiveness`) become downrank candidates.
 */
export interface PostClassificationScores {
  /** Likelihood the content is toxic, harassing, or abusive. */
  toxicity: number;
  /** Degree to which the content is constructive / adds value. */
  constructiveness: number;
  /** Likelihood the content is spam or low-effort promotion. */
  spam: number;
  /** Overall content quality (clarity, substance, effort). */
  quality: number;
  /** Degree to which the content is divisive / controversial. */
  controversy: number;
  /** Strength of negative emotional tone, independent of toxicity. */
  negativity: number;
}

/**
 * Status of a post's classification lifecycle. Classification is populated in two
 * stages that share this single object:
 * - `pending`: not yet processed (default on creation, awaiting the cheap
 *   deterministic baseline and/or the async AI batch).
 * - `baseline`: the cheap, deterministic Stage-A signals (language, region,
 *   normalized hashtags, rule-based topics, sensitive) have been filled at
 *   ingest. The async AI step has not enriched it yet.
 * - `classified`: the async AI Stage-B enrichment (sentiment, intent,
 *   quality/safety scores, refined topics) has completed; `classifiedAt` is set.
 * - `failed`: AI enrichment failed after the retry budget was exhausted.
 */
export type PostClassificationStatus = 'pending' | 'baseline' | 'classified' | 'failed';

/**
 * A single canonical topic on a post, resolved into the Topic registry. This is
 * the relational form of {@link PostClassification.topics}: it carries the same
 * topic `name` (slug) plus the registry `topicId` (when the name resolved to a
 * Topic document) and the discovered `relevance`/`type`. Personalization and
 * trending consume `topicId`; hidden-topic suppression and topic-page lookups
 * consume `name`.
 *
 * `topicId` is absent when the name could not be resolved to a Topic document
 * (e.g. the registry was unreachable at write time); readers that need an id
 * simply skip those entries and treat the topic as name-only.
 */
export interface ClassificationTopicRef {
  /** Lowercase topic slug — the same value stored in {@link PostClassification.topics}. */
  name: string;
  /** Topic-registry id when the name resolved to a Topic document; absent otherwise. */
  topicId?: string;
  /** Discovered relevance 1..10 (AI-extracted); absent for rule-based baseline topics. */
  relevance?: number;
  /** Whether this is an abstract topic or a named entity; absent for baseline topics. */
  type?: 'topic' | 'entity';
}

/**
 * Internal classification metadata for a post — the single content-intelligence
 * object used for ranking, search, recommendations, and moderation. It is
 * populated in two stages that coexist on this one object:
 *
 * - Stage A (deterministic, synchronous at ingest): cheap signals derived
 *   without any network/AI — {@link PostClassification.languages},
 *   {@link PostClassification.region}, {@link PostClassification.hashtagsNorm},
 *   {@link PostClassification.sensitive}, and rule-based {@link PostClassification.topics}.
 *   Runs on EVERY post (native and federated) on the same code path.
 *   {@link PostClassification.version} tracks the deterministic ruleset so posts
 *   can be re-baselined when rules change.
 * - Stage B (AI-inferred, async batch): {@link PostClassification.sentiment},
 *   {@link PostClassification.intent}, {@link PostClassification.scores},
 *   {@link PostClassification.confidence}, and refined topics that merge into the
 *   same {@link PostClassification.topics} list.
 *
 * It is intentionally SEPARATE from user-written {@link Post.hashtags}: hashtags
 * are explicit user tokens; `topics` here are inferred/normalized. The AI
 * provider/model is an infrastructure concern and is deliberately NOT stored on
 * the post.
 */
export interface PostClassification {
  /**
   * Topics/tags (lowercase, normalized slugs). Distinct from hashtags. Seeded by
   * Stage-A rule-based classification and refined/merged by Stage-B AI. This is
   * the lightweight, multikey-indexable slug form used for candidate fetching;
   * {@link PostClassification.topicRefs} carries the same topics enriched with
   * registry linkage for ranking/trending.
   */
  topics: string[];
  /**
   * The canonical topics resolved into the Topic registry — the relational form
   * of {@link PostClassification.topics} (same names, plus `topicId` and
   * discovered `relevance`/`type`). This is the single source of truth for the
   * algorithms (personalization topic-match by `topicId`, hidden-topic
   * suppression by `name`, trending aggregation, topic-page lookups). Absent
   * until the Stage-B AI batch resolves them; readers fall back to the slug-only
   * {@link PostClassification.topics} then treat the post as topic-less.
   */
  topicRefs?: ClassificationTopicRef[];
  /**
   * Stage-A. ALL detected/declared ISO 639-1 languages on the post (e.g. a
   * bilingual ES+EN post, or a Mastodon `contentMap` declaring several), primary
   * (dominant/declared) language first, deduped. This is the SINGLE canonical
   * classification-language field — there is no separate single-value field;
   * consumers read the array (the top-level {@link Post.language} carries the
   * single primary for the ActivityPub protocol). Absent when no language could
   * be determined, and absent on posts that predate multi-language classification
   * until the version-gated backfill populates them (language-match then goes
   * neutral for those posts).
   */
  languages?: string[];
  /**
   * Stage-A. Best-effort coarse region/country code (e.g. `'DE'`) or zone.
   * Deliberately weak — derived from a federated instance domain/TLD or locale —
   * and absent (`undefined`) when unknown. Never inferred from post text.
   */
  region?: string;
  /**
   * Stage-A. Canonical hashtags for this post: lowercase, `#`-stripped, trimmed,
   * deduplicated, alias-mapped. Mirrors the same normalization used for
   * {@link Post.hashtags} so ranking/discovery read one canonical form.
   */
  hashtagsNorm?: string[];
  /**
   * Stage-A. Candidate TREND TERMS extracted from the post's own text: unigrams
   * and adjacent-word phrases, lowercased and stop-word-filtered, with any `#`
   * marker stripped so a hashtag and the bare word collapse to ONE term
   * (`#FIFA`, `#fifa` and `FIFA` are all `fifa`).
   *
   * This is what makes trend detection a property of what people WROTE rather
   * than of who happened to type a `#`. Trending unions this with
   * {@link PostClassification.hashtagsNorm} and {@link PostClassification.topics}
   * into a single term space, so a burst is measured the same way whichever form
   * it arrived in.
   *
   * Absent on posts that predate term extraction; the union above is what keeps
   * detection working (on hashtags and topic slugs alone) for those, and the
   * corpus self-heals as new posts land.
   */
  trendTerms?: string[];
  /** Stage-A. Whether the content is marked sensitive/NSFW (pass-through). */
  sensitive?: boolean;
  /**
   * Stage-A. Version of the deterministic classifier ruleset that produced the
   * baseline signals. Bumped when the rules/taxonomy change so posts can be
   * re-baselined. Absent on posts that only carry legacy AI fields.
   */
  version?: number;
  /** Stage-B (AI). Absent until the post reaches `classified`. */
  sentiment?: PostSentiment;
  /** Stage-B (AI). Absent until the post reaches `classified`. */
  intent?: PostIntent;
  /** Stage-B (AI). Absent until the post reaches `classified`. */
  scores?: PostClassificationScores;
  /** Stage-B (AI). Overall confidence in the AI classification, 0..1. Absent until `classified`. */
  confidence?: number;
  status: PostClassificationStatus;
  /** When the post was successfully AI-classified (Stage B). Absent until `classified`. */
  classifiedAt?: Date;
}

export type PostAuthorRole = 'owner' | 'collaborator';
export type PostAuthorStatus = 'accepted' | 'pending' | 'declined' | 'stopped';

/**
 * How a person comes to be NAMED in a post's byline.
 *
 * A superset of {@link PostAuthorRole} because one byline entry is not an
 * `authorship` entry at all: the human who wrote a post published by a `channel`
 * account is recorded on `Post.writtenByOxyUserId`, deliberately OUTSIDE
 * `authorship` — putting them in it would return the post to their own profile
 * and their followers' timelines, which is the whole thing a channel decouples.
 *
 * They still belong in the byline when the channel discloses them, so
 * {@link HydratedAuthor} carries this wider role rather than claiming they are a
 * `collaborator`. `authorship` keeps the narrower {@link PostAuthorRole}, so no
 * authorship code has a `writer` case to handle.
 */
export type PostBylineRole = PostAuthorRole | 'writer';

export interface PostAuthorshipEntry {
  oxyUserId: string;
  role: PostAuthorRole;
  status: PostAuthorStatus;
  invitedAt?: string;
  respondedAt?: string;
}

export const MAX_POST_COLLABORATORS = 5;

/**
 * Whether a post is published, and if not, why not.
 *
 * The three author-driven states are the ones a composer produces. `restricted`
 * is the fourth and is NOT one a client can ask for: it is set only by
 * moderation enforcement acting on a published CrowdSource decision, and cleared
 * only by the restore path when a correction supersedes that decision.
 *
 * It lives on this axis rather than in a subdocument of its own because every
 * feed source and the post-hydration ACL already require `status: 'published'`.
 * Reusing the invariant means a restricted post leaves discovery, ranking,
 * search and every DTO the moment the field is written, with no query left
 * behind to forget — while the author's own `visibility` choice survives intact
 * for the restore.
 *
 * {@link CreatePostRequest} deliberately keeps the narrow three-state union.
 */
export type PostPublicationStatus = 'draft' | 'published' | 'scheduled' | 'restricted';

export interface Post {
  id: string;
  _id?: string;
  oxyUserId: string; // Links to Oxy user (denormalized owner cache)
  /** Canonical multi-author list. Always includes exactly one owner with status accepted. */
  authorship?: PostAuthorshipEntry[];
  type: PostType;
  content: PostContent;
  visibility: PostVisibility;
  isEdited: boolean;
  editHistory?: string[];
  language?: string;
  tags?: string[];
  mentions?: string[]; // oxyUserIds
  /**
   * Every hashtag detected for this post, in canonical form: lowercase, without
   * the leading `#`, deduplicated, first-seen order preserved. Populated by the
   * centralized backend normalizer immediately before persistence. Holds ALL
   * detected tags — including ones the normalizer removed from the visible
   * `content.text` when it cleaned a spammy block of 4+ consecutive hashtags.
   * This is the single source of truth for discovery, search, and trending.
   */
  hashtags?: string[];
  boostOf?: string; // original post id
  quoteOf?: string; // quoted post id
  parentPostId?: string; // for replies
  threadId?: string; // for thread posts
  replyPermission?: ReplyPermission[]; // Who can reply and quote this post
  reviewReplies?: boolean; // Whether to review and approve replies before they're visible
  quotesDisabled?: boolean; // Whether quote posts are disabled
  stats: PostStats;
  metadata: PostMetadata;
  location?: GeoJSONPoint; // Post creation location metadata
  status?: PostPublicationStatus;
  scheduledFor?: string;
  /**
   * Internal AI-inferred classification metadata (topics, sentiment, intent,
   * quality/safety scores). Separate from user {@link Post.hashtags}. Populated
   * asynchronously by the classification batch job; defaults to a `pending`
   * status on creation. The AI provider/model is never stored here.
   */
  postClassification?: PostClassification;
  createdAt: string;
  updatedAt: string;
}

export interface PostStats {
  likesCount: number;
  downvotesCount: number;
  boostsCount: number;
  /**
   * Of the total {@link PostStats.boostsCount}, the subset that originated as
   * inbound ActivityPub Announces (federated boosts) rather than native reposts.
   * Maintained in lockstep with `boostsCount` at the federated import/undo sites,
   * so `boostsCount - federatedBoostsCount` yields the native boost count.
   * Defaults to 0; a version-gated backfill populates it for posts that predate
   * the field.
   */
  federatedBoostsCount: number;
  commentsCount: number;
  viewsCount: number;
  sharesCount: number;
  /** Number of authoritative Bookmark rows for this post. */
  savesCount: number;
}

export interface PostMetadata {
  isSensitive?: boolean;
  /**
   * Content-warning label from a federated source (ActivityPub `summary`, e.g.
   * Mastodon's content warning). Present only on federated posts that carry a CW;
   * the frontend renders it as a spoiler header gating the body.
   */
  spoilerText?: string;
  isPinned?: boolean;
  isBoosted?: boolean;
  isCommented?: boolean;
  isFollowingAuthor?: boolean;
  authorBlocked?: boolean;
  authorMuted?: boolean;
  hideEngagementCounts?: boolean;
  // Collaborative post federation lifecycle flags
  /** Set when a post with pending collab invites defers its fediverse delivery. Cleared once federation runs. */
  collabFederationDeferred?: boolean;
  /** Set after the post has been successfully delivered to the fediverse. Prevents a second delivery on invite resolution. */
  federationDelivered?: boolean;
}

/**
 * Subset of {@link PostMetadataState} that callers may set when creating a
 * post. Server-managed fields (timestamps, visibility, etc.) live elsewhere.
 */
export interface CreatePostMetadata {
  isSensitive?: boolean;
  hideEngagementCounts?: boolean;
  language?: string;
}

export interface CreatePostRequest {
  content: PostContentInput;
  visibility?: PostVisibility;
  /** Up to {@link MAX_POST_COLLABORATORS} local users to invite as co-authors. */
  collaboratorIds?: string[];
  parentPostId?: string;
  threadId?: string;
  /**
   * Source post for a quote. The frontend uses camelCase; the HTTP wire
   * format snake-cases this to `quoted_post_id` (see `feedService.createPost`).
   */
  quotedPostId?: string;
  tags?: string[];
  mentions?: string[];
  hashtags?: string[];
  replyPermission?: ReplyPermission[];
  reviewReplies?: boolean;
  quotesDisabled?: boolean;
  status?: 'draft' | 'published' | 'scheduled';
  scheduledFor?: string;
  metadata?: CreatePostMetadata;
  /**
   * The author's own lane for this post — an editorial decision about original
   * content, so the server refuses it on a reply or a boost (400). A quote takes
   * one: it is an original post with its own body and its own profile row.
   */
  laneId?: string;
  /**
   * Publish this post AS another Oxy account the caller operates. The post is
   * AUTHORED BY that account: it carries the account's `oxyUserId` and its
   * `authorship`, so it lands on that account's profile and in the timelines of
   * its followers, and it renders with its avatar and name because `user` IS that
   * account.
   *
   * The authenticated human is recorded OUTSIDE `authorship`, in
   * `writtenByOxyUserId`, and is disclosed only when the channel sets
   * `signPosts`. Putting them in `authorship` would both break that anonymity and
   * put the post back on their own profile.
   *
   * TWO FAMILIES OF ACCOUNT ARE ACCEPTED, on two different authorities:
   *
   *  - A **channel**, where accepted membership is the whole right. A channel can
   *    never be acted as (`isActAsEligibleKind` refuses it — it is a content
   *    identity, not a seat), so this field, not a session switch, is the ONLY way
   *    a post comes to be authored by one. A channel post is additionally
   *    persisted `replyPermission: ['nobody']` — a channel takes no replies.
   *  - An **organization / project / bot**, where the right is `account:act_as` —
   *    the same permission that would let the caller switch INTO the account. The
   *    point of the field here is signing a post as the account WITHOUT switching;
   *    a member who may not be the account may not sign as it either. Such a post
   *    is an ordinary post in every other respect, replies included.
   *
   * A `personal` account is refused (400): authoring as a human login is
   * impersonation, and its owner posts as it by signing in.
   *
   * To put an account's post on your own profile you boost it; there is no field
   * for that, because a boost is already the right row with the right owner.
   */
  publishAsOxyUserId?: string;
}

export interface CreateThreadPostRequest {
  content: PostContentInput;
  visibility?: PostVisibility;
  tags?: string[];
  mentions?: string[];
  hashtags?: string[];
  replyPermission?: ReplyPermission[];
  reviewReplies?: boolean;
  quotesDisabled?: boolean;
  metadata?: CreatePostMetadata;
  /**
   * The lane for a thread post. A thread's continuations are REPLIES, which
   * carry no lane, so this is honored on the thread's ROOT only — the feed
   * renders the thread as one slice anchored on the root, which is where the
   * chip belongs anyway.
   */
  laneId?: string;
  /**
   * Publish THIS entry as another Oxy account the caller operates — the same
   * field, the same authorization and the same effects as
   * {@link CreatePostRequest.publishAsOxyUserId}, decided per entry so one batch
   * can post from several accounts.
   *
   * **`beast` mode only.** In `beast` mode the entries are independent top-level
   * posts, so each may name its own account and they may all differ. In `thread`
   * mode they are one conversation whose continuations are REPLIES to the entry
   * before them, and a reply can never be published as another account — so the
   * server refuses the field outright there (400) rather than letting the author
   * believe an identity was applied that a mid-thread post could not carry.
   *
   * Refused for the WHOLE request before any entry is written, like every other
   * batch-level refusal here: half a batch cannot be undone in one action.
   */
  publishAsOxyUserId?: string;
}

export interface CreateThreadRequest {
  mode: 'thread' | 'beast'; // thread = linked posts, beast = separate posts
  posts: CreateThreadPostRequest[];
  /**
   * ISO time to publish the whole batch at, instead of immediately. BEAST mode
   * only — the server refuses it in thread mode, where each continuation is
   * created as a reply to the one before it and publishing them separately would
   * let a reply precede the post it answers. One time covers every post: the
   * author picked a moment for the set.
   */
  scheduledFor?: string;
}

export interface UpdatePostRequest {
  content?: PostContent;
  visibility?: PostVisibility;
  tags?: string[];
  mentions?: string[];
  hashtags?: string[];
  /** Invite collaborators when editing a solo post within the 30-minute window. */
  collaboratorIds?: string[];
  /**
   * Move a still-SCHEDULED post to another time, ISO-8601. Accepted only while
   * the stored post is `scheduled`, and only for a time still ahead; earlier is
   * allowed. Omitted, the existing schedule stands.
   */
  scheduledFor?: string;
  /**
   * Move the post to another of the author's lanes, or out of every lane with
   * `null`. Served by `PATCH /posts/:id/lane`, which carries NO edit window —
   * see that handler for why.
   */
  laneId?: string | null;
}

export interface PostFeed {
  posts: Post[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface PostFilters {
  authorId?: string;
  type?: PostType;
  visibility?: PostVisibility;
  hashtags?: string[];
  mentions?: string[];
  dateFrom?: string;
  dateTo?: string;
  isEdited?: boolean;
} 

/**
 * Normalized API response structures for hydrated posts
 */

/**
 * Canonical embedded user identity on a post DTO — the SAME shape as the Oxy
 * `User` / `PublicUserProfile` (`@oxyhq/core` / `@oxyhq/contracts`). Oxy is the
 * single authority for user identity, so post hydration passes Oxy user fields
 * through UNCHANGED: there is NO Mention-local reshape (no flat `displayName`,
 * no pre-resolved `avatarUrl`, no wire `handle`).
 *
 * Renderers use ONE pattern (identical to Who-to-follow / the profile header):
 *  - name:   `name.displayName`, handle fallback via `getNormalizedUserHandle`
 *            / `displayNameOrHandle` — never show a blank name.
 *  - avatar: `<Avatar source={avatar} variant="thumb" />` through Bloom's
 *            `ImageResolver`. `avatar` is a bare Oxy file id; for a federated
 *            actor whose image was mirrored as a raw URL it may be an absolute
 *            `http(s)` URL, which Bloom renders directly.
 *  - handle: `getNormalizedUserHandle(user)` (reads `username` + `federation`/
 *            `instance`) — never a Mention-local `handle` field on the wire.
 *
 * A degraded/unresolvable author is represented with an EMPTY `username` and a
 * neutral `name.displayName: 'Unknown user'` (see `degradedActorSummary`), which
 * suppresses the `@handle` line and the profile link (the ghost-handle rule).
 */
export interface PostUser {
  id: string;
  username?: string;
  /** Canonical structured name; render `name.displayName` directly when present. */
  name: UserNameResponse;
  /** Bare Oxy file id (resolved by Bloom's ImageResolver) OR an absolute remote URL. */
  avatar?: string | null;
  verified?: boolean;
  /**
   * What the account IS — `personal`, `organization`, `project`, `bot`,
   * `channel`. Oxy's user DTO already carries it (verified live: a profile read
   * returns `kind: 'personal'`), and this interface is the canonical Oxy `User`
   * shape passed through unchanged, so omitting it was the anomaly.
   *
   * It earns its place rather than merely fitting: a post authored by a channel
   * account is an ORDINARY post whose author happens to be a channel, and the
   * row has to link to `/c/<handle>` instead of `/@<handle>`. Without this the
   * renderer cannot tell, and the only alternative is to send every author link
   * to `/@<handle>` and let the profile screen bounce — correct, but a wasted
   * navigation on every channel post.
   *
   * `AccountKind` comes from `@oxyhq/contracts`, which owns the account graph
   * and which this file already imports from — restating the union here would
   * be a second definition free to drift from the one the server validates
   * against.
   */
  kind?: AccountKind;
  isFederated?: boolean;
  federation?: { domain?: string; actorUri?: string; actorId?: string };
  instance?: string;
}

/**
 * Owner-only source used to prefill the post editor.
 *
 * Unlike a hydrated post, `content.text` and every author variant retain raw
 * `[mention:<id>]` placeholders. `mentionUsers` carries canonical Oxy identity
 * for display when it resolves; an id can remain in `mentions` without a user
 * entry during an identity-service outage, preserving the stable reference
 * without inventing a handle.
 */
export interface PostEditSource {
  id: string;
  content: PostContent;
  mentions: string[];
  mentionUsers: PostUser[];
  authorship?: PostAuthorshipEntry[];
  parentPostId?: string;
  /**
   * The post's publication state. The composer needs it to know it is editing
   * something that has NOT gone out yet: a scheduled post is exempt from the
   * 30-minute edit window and can still be moved to another time, so the screen
   * must not tell the author about a deadline that does not apply to them.
   */
  status?: PostPublicationStatus;
  /** When a `scheduled` post is due to publish, ISO-8601. */
  scheduledFor?: string;
}

export interface HydratedAuthor extends PostUser {
  role: PostBylineRole;
  status: PostAuthorStatus;
}

export interface PostViewerState {
  isOwner: boolean;
  isCollaborator: boolean;
  collabInvitePending?: boolean;
  viewerRole?: PostAuthorRole;
  isLiked: boolean;
  isDownvoted: boolean;
  isBoosted: boolean;
  isSaved: boolean;
}

export interface PostPermissions {
  canReply: boolean;
  canDelete: boolean;
  canPin: boolean;
  canViewSources: boolean;
  canEdit?: boolean;
  canStopSharing?: boolean;
  canViewInsights?: boolean;
}

export interface PostEngagementSummary {
  likes: number | null;
  downvotes: number | null;
  boosts: number | null;
  replies: number | null;
  saves?: number | null;
  /**
   * Posts that quote this one. Unlike the other counters this is NOT denormalized
   * onto `stats` — it is counted on read off the `quoteOf` index, so it is only
   * present when the caller asked for it (`includeQuoteCounts`, the post-detail
   * endpoints). Absent on feed DTOs, where nothing renders it.
   */
  quotes?: number | null;
  views?: number | null;
  impressions?: number | null;
  recentReplierAvatars?: string[];
}

export interface PostAttachmentBundle {
  media?: MediaItem[];
  poll?: PollData;
  article?: PostArticleContent;
  sources?: PostSourceLink[];
  location?: GeoJSONPoint;
  event?: PostEventContent;
  room?: PostRoomContent;
  podcast?: PostPodcastContent;
}

export interface PostLinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

/**
 * Maximum number of link-preview cards attached to a single post. Shared by the
 * backend (URL extraction + hydration) and the frontend (composer preview +
 * post rendering) so the two cannot diverge on how many links a post shows.
 */
export const MAX_POST_LINK_PREVIEWS = 4;

export interface PostFeedContext {
  reason?: string;
  position?: number;
  parentThreadId?: string;
  isThreadParent?: boolean;
}

export interface PostMetadataState {
  visibility: PostVisibility;
  replyPermission?: ReplyPermission[];
  reviewReplies?: boolean;
  quotesDisabled?: boolean;
  isPinned?: boolean;
  isSensitive?: boolean;
  /**
   * Content-warning label from a federated source (ActivityPub `summary`). Set on
   * federated posts carrying a CW; the frontend renders it as a spoiler header.
   */
  spoilerText?: string;
  hideEngagementCounts?: boolean;
  isThread?: boolean;
  /**
   * Top-level ActivityPub primary language (`postClassification.languages[0]`).
   * Absent when no language could be determined.
   */
  language?: string;
  /**
   * ALL detected/declared ISO 639-1 languages (primary first), from the canonical
   * `postClassification.languages` array. Consumers doing language-match (e.g. the
   * feed language tuner) read this array with any-overlap semantics; the single
   * {@link PostMetadataState.language} is the protocol-facing primary.
   */
  languages?: string[];
  tags?: string[];
  mentions?: string[];
  hashtags?: string[];
  createdAt: string;
  updatedAt: string;
  status?: PostPublicationStatus;
  /**
   * When a `scheduled` post is due to publish, ISO-8601. Present ONLY on a post
   * that carries one, which in practice means `status === 'scheduled'` — and
   * hydration drops an unpublished post for everyone except its owner and its
   * accepted/pending collaborators, so this never reaches a third party.
   */
  scheduledFor?: string;
}

/**
 * "This post is a reply, and this is what it answers."
 *
 * The SINGLE carrier of reply context. It rides on the POST, not on the feed
 * slice that happens to contain it, because a post is a reply as a property of
 * itself — independent of which surface renders it. Before this existed the only
 * carrier was `FeedSliceReason.replyContext`, which the server emits solely for
 * feeds whose definition opted in (`execution.replyContext`) and never at all on
 * the response paths that return no slices (the popular fallback, ordered feeds,
 * feed generators). Every other surface that renders a post — search, saved,
 * insights, the scheduled-post preview, the thread view — had no access to it,
 * so a reply on those surfaces was indistinguishable from a top-level post.
 *
 * Present on every post that is a reply, decided by the server's one definition
 * of the concept (`isReplyPost`), which counts a federated reply whose
 * `inReplyTo` never resolved locally. `parentAuthor` is therefore optional and
 * the empty object is meaningful: "this is a reply, but we cannot say to whom".
 *
 * ONE exclusion: a reply to its OWN author's post — a self-thread continuation —
 * carries no `replyContext` at all. It is a reply, but it is rendered as a
 * THREAD (connector line, "Show this thread"), and a "Replying to @themselves"
 * header on every post after the first is noise on a very common shape. The
 * server decides this because only it holds both authoritative author ids: a
 * post's `user.id` is a degraded, post-id based placeholder for orphan federated
 * posts, so a client-side comparison would silently never match on exactly those.
 *
 * Note this is narrower than "present iff the post is a reply" — consumers that
 * need the raw fact should read {@link HydratedPostSummary.parentPostId}. What
 * this field answers is "does this row need to tell the reader what it answers".
 *
 * The local parent id is NOT repeated here — it is already
 * {@link HydratedPostSummary.parentPostId}, and one value with two spellings is
 * how carriers drift apart. This object answers only "to WHOM", which nothing
 * else on the DTO carries.
 */
export interface PostReplyContext {
  /**
   * The parent's author. Absent when the parent is not held locally (an
   * unresolved federated `inReplyTo`), AND when the viewer's own ACL denies the
   * parent — naming the author of a post this viewer was just refused would leak
   * both its existence and its writer, so the same gate that drops a post from a
   * response drops its authorship here.
   */
  parentAuthor?: PostUser;
}

export interface HydratedPostSummary {
  id: string;
  content: PostContent;
  attachments: PostAttachmentBundle;
  /**
   * Resolved link previews for the post text, in text order, capped at
   * {@link MAX_POST_LINK_PREVIEWS}. Unresolved URLs are omitted, so this can be
   * shorter than the number of links in the text (or empty).
   */
  linkPreviews?: PostLinkPreview[];
  /** Primary author (owner) — backward-compatible single-author field. */
  user: PostUser;
  /**
   * Everyone the byline NAMES, for multi-author header rendering: the owner,
   * then each accepted collaborator, then — on a post published by a `channel`
   * account that sets `signPosts` — the human who wrote it (`role: 'writer'`).
   *
   * The writer is disclosed HERE or not at all: there is deliberately no
   * `writtenByOxyUserId` on this DTO. Shipping the raw id whenever the column
   * holds one would end the anonymity of every channel that did NOT opt in,
   * whatever a renderer then chose to draw — so the decision is made once, on
   * the server, and an undisclosed writer never crosses the wire.
   *
   * `user` stays the CHANNEL either way. The channel is the signature; the
   * writer is a second author, never the primary.
   */
  authors: HydratedAuthor[];
  /** Full authorship state when the viewer is a participant. */
  authorship?: PostAuthorshipEntry[];
  engagement: PostEngagementSummary;
  viewerState: PostViewerState;
  permissions: PostPermissions;
  metadata: PostMetadataState;
  /**
   * The author's lane for this post, when it has one — what the name row renders
   * as a `› Lane name` chip after the time.
   *
   * It rides on the DTO rather than arriving as a render prop on purpose: a
   * recycled row that kept the previous row's lane is a class of bug the DTO
   * makes unreachable.
   */
  lane?: LaneSummary;
  /**
   * There is deliberately NO `channel` field here.
   *
   * A channel is an Oxy account, so a channel post is authored BY it: `user` IS
   * the channel, with its real avatar, name and `/c/<handle>` identity. The
   * previous shape carried the channel alongside a DELIBERATELY DEGRADED `user`,
   * because Oxy owns identity and no `PostUser` could be fabricated from a
   * Mention-local channel row — which is exactly the workaround this replaced.
   * Anything re-adding a channel field is re-introducing a second identity for a
   * post, and the renderer would once again have to choose between them.
   */
  parentPostId?: string;
  /**
   * Set on every post that IS a reply, on every surface, whatever the feed did
   * with slicing. Its PRESENCE is the reply marker — which `parentPostId` alone
   * cannot be, because a federated reply whose `inReplyTo` never resolved is a
   * reply with no local parent. See {@link PostReplyContext}.
   */
  replyContext?: PostReplyContext;
}

export interface HydratedBoostContext {
  /**
   * The boosted original. `null` ONLY when the original is genuinely gone
   * (deleted or never imported) — paired with `unavailable: true`. A boost has an
   * empty body, so the client renders an "unavailable" placeholder rather than a
   * blank card. When the original exists this is always populated.
   */
  originalPost: HydratedPostSummary | null;
  actor: PostUser;
  /**
   * True when the boosted original no longer exists (deleted/never-imported), so
   * `originalPost` is null. Distinct from a boost whose original is hidden from
   * THIS viewer by an ACL/visibility check — that yields `boost: null` (the
   * original's existence is not revealed), not an `unavailable` placeholder.
   */
  unavailable?: boolean;
  reason?: string;
}

export interface HydratedPost extends HydratedPostSummary {
  originalPost?: HydratedPostSummary | null;
  quotedPost?: HydratedPostSummary | null;
  boost?: HydratedBoostContext | null;
  context?: PostFeedContext;
}
