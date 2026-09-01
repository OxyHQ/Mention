/**
 * The request-body readers every post-composition handler shares.
 *
 * `createPost`, `createThread` and `updatePost` all accept the same
 * client-supplied composition payload — sources, article, event, room,
 * attachment order — and all three must bound and normalise it identically. The
 * readers live here so a bound tightened on create cannot be missed on update.
 */

import { z } from 'zod';
import { PostAttachmentDescriptor, PostAttachmentType, PostVisibility } from '@mention/shared-types';
import type { ReplyPermission } from '@mention/shared-types';
import { config } from '../../config';
import type { NormalizedMediaItem } from '../../utils/mediaInput';

/**
 * An article whose id is minted but whose row is not written yet.
 *
 * The post's content document has to carry `articleId`, and the article row must
 * not exist until the post it belongs to does — so the id is minted first and
 * the insert happens after the post succeeds. See `db/posts/articleRepository.ts`.
 */
export interface PendingArticle {
  id: string;
  createdBy: string;
  title?: string;
  body?: string;
}

// Constants from centralized config
const MAX_SOURCES = config.posts.maxSources;
const MAX_SOURCE_TITLE_LENGTH = config.posts.maxSourceTitleLength;
const MAX_ARTICLE_TITLE_LENGTH = config.posts.maxArticleTitleLength;
export const MAX_ARTICLE_EXCERPT_LENGTH = config.posts.maxArticleExcerptLength;
export const DEFAULT_POLL_DURATION_DAYS = config.posts.defaultPollDurationDays;
export const MAX_POLL_DURATION_DAYS = config.posts.maxPollDurationDays;
export const MAX_HASHTAG_LENGTH = config.posts.maxHashtagLength;
export const MAX_HASHTAGS_PER_POST = config.posts.maxHashtagsPerPost;
const MAX_EVENT_NAME_LENGTH = config.posts.maxEventNameLength;
const MAX_EVENT_LOCATION_LENGTH = config.posts.maxEventLocationLength;
const MAX_EVENT_DESCRIPTION_LENGTH = config.posts.maxEventDescriptionLength;
export const MAX_TEXT_LENGTH = config.posts.maxTextLength;
const MAX_POLL_OPTIONS = config.posts.maxPollOptions;
const MAX_POLL_OPTION_LENGTH = config.posts.maxPollOptionLength;

/**
 * ## The four client fields that reach a CONSTRAINED column unread
 *
 * `hashtags`, `visibility`, `replyPermission` and `content.poll` were all
 * carried from `req.body` to the write with a truthiness test or a bare cast,
 * which is a 500 for anything but the shape the composer happens to send:
 * `mergeHashtags` calls `.map` on whatever it is handed (a truthy non-array is a
 * `TypeError`), `visibility` and `replyPermission` land in columns guarded by
 * `posts_visibility_check` / `posts_reply_permission_check`, and a poll's
 * question and options are inserted as text with no bound at all.
 *
 * They are read HERE, once, for the same reason the sanitizers below are: a
 * bound tightened on create must not be missable on update, and the thread
 * composer must not be able to accept a poll the single-post composer refuses.
 *
 * ## Falsy means "not supplied", everywhere
 *
 * Every one of these fields was written as `value || <default>`, so `undefined`,
 * `null`, `''` and `0` have always selected the default rather than being
 * refused. The handlers therefore parse only a TRUTHY value: the refusals below
 * are additions to what a request could already fail on, never to what it could
 * already succeed with.
 */

/** Message shared by every way `hashtags` can fail to be a list of tags. */
const INVALID_HASHTAG_MESSAGE =
  `Invalid hashtag: each must be a string of at most ${MAX_HASHTAG_LENGTH} characters`;

/**
 * The `hashtags` array as a client submits it.
 *
 * The count and per-tag bounds are the ones `POST /posts` already answered a 400
 * for; what is new is that they now apply on the thread and update paths too,
 * which had no bound of any kind, and that a NON-array is a 400 rather than the
 * `TypeError` → 500 `mergeHashtags` produced for one.
 */
export const hashtagsSchema = z
  .array(
    z.string(INVALID_HASHTAG_MESSAGE).max(MAX_HASHTAG_LENGTH, INVALID_HASHTAG_MESSAGE),
    INVALID_HASHTAG_MESSAGE,
  )
  .max(MAX_HASHTAGS_PER_POST, `Too many hashtags: maximum is ${MAX_HASHTAGS_PER_POST}`);

/**
 * The `visibility` a client asks for, mapped to the stored enum.
 *
 * `followers` is an ACCEPTED SPELLING of `followers_only`, not a typo tolerated
 * by accident — `POST /posts` has always mapped it, and dropping it here would
 * change what that route accepts.
 *
 * The two callers dispose of a value this REFUSES differently, and neither
 * choice is free to change. `POST /posts` has always fallen back to `public` for
 * anything it did not recognise, and narrowing that would refuse bodies that
 * publish today. `POST /posts/thread` cannot fall back: its entries are written
 * one at a time, so a value the column refuses on entry three leaves entries one
 * and two published — the half-thread every other pre-flight in that handler
 * exists to prevent — and defaulting a batch to `public` would publish n posts
 * to an audience nobody asked for.
 */
export const postVisibilitySchema = z
  .enum(['public', 'followers', 'followers_only', 'private'], 'Invalid visibility')
  .transform((value) => {
    if (value === 'private') return PostVisibility.PRIVATE;
    if (value === 'public') return PostVisibility.PUBLIC;
    return PostVisibility.FOLLOWERS_ONLY;
  });

/**
 * `replyPermission`, whose vocabulary is `ReplyPermission`.
 *
 * Spelled as a map rather than a tuple so `satisfies` makes it EXHAUSTIVE: a
 * permission added to `ReplyPermission` and not to this object fails to compile,
 * where a hand-written tuple would simply start refusing the new value. The
 * array is declared here rather than imported from `db/schema/posts.ts` because
 * a controller may not reach into `db/` (`validate:architecture-boundaries`).
 *
 * An EMPTY array is accepted, as it always has been: `posts_reply_permission_check`
 * admits it, and the application — not the schema — decides what it means.
 */
const REPLY_PERMISSION_VALUES = {
  anyone: 'anyone',
  followers: 'followers',
  following: 'following',
  mentioned: 'mentioned',
  nobody: 'nobody',
} as const satisfies Record<ReplyPermission, ReplyPermission>;

export const replyPermissionSchema = z.array(
  z.enum(REPLY_PERMISSION_VALUES, `replyPermission must be one of: ${Object.keys(REPLY_PERMISSION_VALUES).join(', ')}`),
  'replyPermission must be an array',
);

/**
 * A poll as the composer submits it inside `content`.
 *
 * `question` and `options` were inserted verbatim: an object question became the
 * row `'[object Object]'`, an object option became an option labelled
 * `'[object Object]'`, and two hundred options became two hundred rows. The
 * booleans were `x || false`, which drove a truthy NON-boolean into a
 * `boolean NOT NULL` column and stored the OPPOSITE of what was asked (measured:
 * `isMultipleChoice: 'yes'` stores `false`).
 *
 * ### Why `question` is bounded by the POST BODY's length and not by
 * `maxPollQuestionLength`
 *
 * The composer does not require a poll question. When none is typed it sends
 * `pollTitle.trim() || postContent.trim() || 'Poll'` (`frontend/utils/postBuilder.ts`,
 * on both the single-post and the thread path), so the question a real request
 * carries can be the entire post body — up to `MAX_TEXT_LENGTH`. Bounding it at
 * the 280 `POST /polls` uses would 400 a body the app sends today. Tightening it
 * is a frontend change first.
 *
 * ### `options` may hold ONE
 *
 * Also the composer: it attaches a poll as soon as a single option is non-empty
 * and then filters the empties out, so a one-option poll is a request the app
 * really makes and really publishes. `POST /polls` and the MCP tool both require
 * two; matching them here would refuse it. What the minimum of one DOES refuse is
 * the empty array — a poll nobody can answer, attached to a post that publishes.
 *
 * `endTime` stays a string or a number, the values `new Date()` reads. Anything
 * else already produced a 400 on `POST /posts` (an unparseable or past date), so
 * naming the type here changes the message and not the answer.
 */
export const pollInputSchema = z.object({
  question: z
    .string('Poll question is required')
    .min(1, 'Poll question is required')
    .max(MAX_TEXT_LENGTH, `Poll question exceeds maximum length of ${MAX_TEXT_LENGTH} characters`),
  options: z
    .array(
      z
        .string('Every poll option must be a non-empty string')
        .min(1, 'Every poll option must be a non-empty string')
        .max(MAX_POLL_OPTION_LENGTH, `Every poll option must be ${MAX_POLL_OPTION_LENGTH} characters or less`),
      'A poll needs at least one option',
    )
    .min(1, 'A poll needs at least one option')
    .max(MAX_POLL_OPTIONS, `A poll may have at most ${MAX_POLL_OPTIONS} options`),
  endTime: z.union([z.string(), z.number()], 'Invalid poll end time').nullish(),
  isMultipleChoice: z.boolean('isMultipleChoice must be a boolean').nullish(),
  isAnonymous: z.boolean('isAnonymous must be a boolean').nullish(),
}, 'A poll must be an object with a question and options');

/** A poll that has passed {@link pollInputSchema}. */
export type ParsedPollInput = z.infer<typeof pollInputSchema>;

/**
 * The 400 body these handlers already answer with, from a failed `safeParse`.
 *
 * `{ message }` is the envelope `POST /posts`, `POST /posts/thread` and
 * `PUT /posts/:id` use for every other refusal, and the parse runs INSIDE the
 * handler rather than as `validateBody` in the route position for the reason
 * `controllers/polls.controller.ts` documents: the middleware answers a
 * different envelope and would move the 400 ahead of the handler's 401.
 */
export const parseFailureMessage = (error: z.ZodError): string =>
  error.issues.map((issue) => issue.message).join('; ');

export const buildPostMetadata = (metadata: unknown): Record<string, unknown> => {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }

  const incomingMetadata = metadata as Record<string, unknown>;
  const postMetadata: Record<string, unknown> = {};

  if (incomingMetadata.isSensitive === true) {
    postMetadata.isSensitive = true;
  }

  return postMetadata;
};

/**
 * Sanitize and validate sources array.
 * Returns { sources, error } — error is set if the array exceeds the max size.
 */
export const sanitizeSources = (arr: unknown): { sources: Array<{ url: string; title?: string }>; error?: string } => {
  if (!Array.isArray(arr)) return { sources: [] };

  if (arr.length > MAX_SOURCES) {
    return { sources: [], error: `Too many sources: maximum is ${MAX_SOURCES}, received ${arr.length}` };
  }

  const normalized = arr
    .map((item: unknown) => {
      if (!item) return null;
      const rawUrl = typeof item === 'string' ? item : (item as Record<string, unknown>).url;
      if (!rawUrl || typeof rawUrl !== 'string') return null;

      const urlTrimmed = rawUrl.trim();
      if (!urlTrimmed) return null;

      try {
        const parsed = new URL(urlTrimmed);
        const normalizedUrl = parsed.toString();
        const titleRaw = (item as Record<string, unknown>)?.title;
        const title = typeof titleRaw === 'string' ? titleRaw.trim().slice(0, MAX_SOURCE_TITLE_LENGTH) : undefined;
        return title ? { url: normalizedUrl, title } : { url: normalizedUrl };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ url: string; title?: string }>;

  return { sources: normalized };
};

export const sanitizeArticle = (input: unknown): { title?: string; body?: string } | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title.trim().slice(0, MAX_ARTICLE_TITLE_LENGTH) : undefined;
  const body = typeof obj.body === 'string' ? obj.body.trim() : undefined;
  if (!title && !body) return undefined;
  return { ...(title ? { title } : {}), ...(body ? { body } : {}) };
};

export const sanitizeEventData = (eventData: unknown): { eventId?: string; name?: string; date?: string; location?: string; description?: string } | null => {
  if (!eventData || typeof eventData !== 'object') return null;
  const obj = eventData as Record<string, unknown>;

  const sanitized = {
    eventId: typeof obj.eventId === 'string' ? obj.eventId.trim() : undefined,
    name: typeof obj.name === 'string' ? obj.name.trim().slice(0, MAX_EVENT_NAME_LENGTH) : undefined,
    date: typeof obj.date === 'string'
      ? obj.date.trim()
      : (obj.date instanceof Date ? obj.date.toISOString() : undefined),
    location: typeof obj.location === 'string' ? obj.location.trim().slice(0, MAX_EVENT_LOCATION_LENGTH) : undefined,
    description: typeof obj.description === 'string' ? obj.description.trim().slice(0, MAX_EVENT_DESCRIPTION_LENGTH) : undefined,
  };

  if (!sanitized.name || !sanitized.date) return null;

  try {
    const dateObj = new Date(sanitized.date);
    if (isNaN(dateObj.getTime())) return null;
  } catch {
    return null;
  }

  return sanitized;
};

export const sanitizeRoomData = (roomData: unknown): { roomId: string; title: string; status?: string; topic?: string; host?: string } | null => {
  if (!roomData || typeof roomData !== 'object') return null;
  const obj = roomData as Record<string, unknown>;
  const id = obj.roomId;
  if (typeof id !== 'string' || typeof obj.title !== 'string') return null;

  return {
    roomId: id.trim(),
    title: obj.title.trim().slice(0, 200),
    ...(typeof obj.status === 'string' && ['scheduled', 'live', 'ended'].includes(obj.status) ? { status: obj.status } : {}),
    ...(typeof obj.topic === 'string' ? { topic: obj.topic.trim().slice(0, 100) } : {}),
    ...(typeof obj.host === 'string' ? { host: obj.host.trim() } : {}),
  };
};

type RawAttachmentInput =
  | string
  | {
      type?: string;
      id?: string;
      mediaId?: string;
      mediaType?: string;
      attachmentType?: string;
      kind?: string;
    };

const ATTACHMENT_TYPES: PostAttachmentType[] = ['media', 'poll', 'article', 'event', 'room', 'location', 'sources', 'podcast'];

const normalizeAttachmentInput = (entry: RawAttachmentInput): PostAttachmentDescriptor | null => {
  if (!entry) return null;

  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (!trimmed) return null;

    if (trimmed.toLowerCase().startsWith('media:')) {
      const id = trimmed.slice('media:'.length).trim();
      if (!id) return null;
      return { type: 'media', id };
    }

    const lower = trimmed.toLowerCase();
    if ((ATTACHMENT_TYPES as string[]).includes(lower)) {
      return { type: lower as PostAttachmentType };
    }
    return null;
  }

  if (typeof entry === 'object') {
    const typeValue = entry.type || entry.attachmentType || entry.kind;
    if (!typeValue) return null;
    const lowerType = String(typeValue).toLowerCase();
    if (!(ATTACHMENT_TYPES as string[]).includes(lowerType)) return null;

    const descriptor: PostAttachmentDescriptor = { type: lowerType as PostAttachmentType };

    if (descriptor.type === 'media') {
      const id = entry.id || entry.mediaId;
      if (!id) return null;
      descriptor.id = String(id);
      if (entry.mediaType) {
        const mt = String(entry.mediaType).toLowerCase();
        if (mt === 'image' || mt === 'video' || mt === 'gif') {
          descriptor.mediaType = mt as 'image' | 'video' | 'gif';
        }
      }
    }

    return descriptor;
  }

  return null;
};

interface AttachmentBuildOptions {
  rawAttachments?: unknown;
  media: NormalizedMediaItem[];
  includePoll?: boolean;
  includeArticle?: boolean;
  includeEvent?: boolean;
  includeRoom?: boolean;
  includeLocation?: boolean;
  includeSources?: boolean;
  includePodcast?: boolean;
}

export const buildOrderedAttachments = ({
  rawAttachments,
  media,
  includePoll = false,
  includeArticle = false,
  includeEvent = false,
  includeRoom = false,
  includeLocation = false,
  includeSources = false,
  includePodcast = false
}: AttachmentBuildOptions): PostAttachmentDescriptor[] | undefined => {
  const descriptors: PostAttachmentDescriptor[] = [];
  const nonMediaTypes = new Set<PostAttachmentType>();
  const mediaById = new Map<string, NormalizedMediaItem>();
  const usedMedia = new Set<string>();

  media.forEach((item) => {
    mediaById.set(String(item.id), item);
  });

  const addNonMedia = (type: PostAttachmentType) => {
    if (type === 'media') return;
    if (nonMediaTypes.has(type)) return;
    nonMediaTypes.add(type);
    descriptors.push({ type });
  };

  const addMedia = (id: string, explicitType?: 'image' | 'video' | 'gif') => {
    const mediaId = String(id);
    if (usedMedia.has(mediaId)) return;
    const mediaItem = mediaById.get(mediaId);
    if (!mediaItem) return;
    usedMedia.add(mediaId);
    descriptors.push({
      type: 'media',
      id: mediaId,
      mediaType: explicitType || mediaItem.type
    });
  };

  const processEntry = (entry: unknown) => {
    const descriptor = normalizeAttachmentInput(entry as RawAttachmentInput);
    if (!descriptor) return;

    switch (descriptor.type) {
      case 'media': {
        if (descriptor.id) {
          addMedia(descriptor.id, descriptor.mediaType);
        }
        break;
      }
      case 'poll':
        if (includePoll) addNonMedia('poll');
        break;
      case 'article':
        if (includeArticle) addNonMedia('article');
        break;
      case 'event':
        if (includeEvent) addNonMedia('event');
        break;
      case 'room':
        if (includeRoom) addNonMedia('room');
        break;
      case 'location':
        if (includeLocation) addNonMedia('location');
        break;
      case 'sources':
        if (includeSources) addNonMedia('sources');
        break;
      case 'podcast':
        if (includePodcast) addNonMedia('podcast');
        break;
      default:
        break;
    }
  };

  if (Array.isArray(rawAttachments)) {
    rawAttachments.forEach(processEntry);
  } else if (rawAttachments) {
    // Support objects with { order: [...] }
    const rawObj = rawAttachments as Record<string, unknown>;
    const maybeOrder = rawObj.order || rawObj.attachments || rawObj.attachmentOrder;
    if (Array.isArray(maybeOrder)) {
      maybeOrder.forEach(processEntry);
    }
  }

  if (includePoll) addNonMedia('poll');
  if (includeArticle) addNonMedia('article');
  if (includeEvent) addNonMedia('event');
  if (includeRoom) addNonMedia('room');
  if (includeSources) addNonMedia('sources');
  if (includeLocation) addNonMedia('location');
  if (includePodcast) addNonMedia('podcast');

  media.forEach((item) => {
    const id = String(item.id);
    if (!usedMedia.has(id)) {
      addMedia(id);
    }
  });

  return descriptors.length ? descriptors : undefined;
};
