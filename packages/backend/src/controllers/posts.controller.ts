import { Response } from 'express';
import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { getDb } from '../db/postgres';
import { bookmarks as bookmarksTable, likes as likesTable } from '../db/schema/engagement';
import { lanes as lanesTable } from '../db/schema/channels';
import { posts as postsTable } from '../db/schema/posts';
import { postContentVariants } from '../db/schema/postContent';
import {
  CHRONO_DESC,
  deletePostRecord,
  findPostRecords,
  loadPostRecord,
  replacePostContent,
  updatePostRecord,
  type PostRecordPatch,
} from '../db/posts/postRepository';
import { POST_CLASSIFICATION_PENDING, type PostRecord } from '../db/posts/postRecord';
import { ChronoCursor, chronoCursorSql, chronoOrderBy } from '../mtn/feed/CursorBuilder';
import { baselineContentClassifier } from '../services/BaselineContentClassifier';
import { attachPollToPost, createPollWithOptions } from '../db/polls/pollRepository';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { createMentionNotifications } from '../utils/notificationUtils';
import {
  PostVisibility,
  PostAttachmentDescriptor,
  PostAttachmentType,
  PostContent,
  StoredPostContent,
  PostContentVariant,
  type PostCorrectionsResponse,
  PostUser,
  ReplyPermission,
  toBaseLanguages,
} from '@mention/shared-types';
import {
  mentionTextsFromContent,
} from '@mention/shared-types/mentions';
import { userPreferenceService, readInteractionSurface } from '../services/UserPreferenceService';
import { affinityEventService } from '../services/AffinityEventService';
import { postCreationService } from '../services/PostCreationService';
import {
  deleteArticles,
  findArticleById,
  insertArticle,
  newArticleId,
  updateArticle,
} from '../db/posts/articleRepository';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { postHydrationService, resolveUserSummaries, degradedActorSummary } from '../services/PostHydrationService';
import { config } from '../config';
import { mergeHashtags, reconcileMentionIdsForPost } from '../utils/textProcessing';
import { foldProfileLinkMentions } from '../services/profileLinkMentions';
import { createScopedOxyClient, createUserScopedOxyServices } from '../utils/oxyHelpers';
import { extractFollowingIds } from '../utils/privacyHelpers';
import { queryInt, queryString } from '../utils/queryParams';
import { topicSlugSql } from '../utils/postTopicMatch';
import { requestLanguageCandidates } from '../utils/viewerLanguage';
import { getRuntimeSocketServer } from '../runtime/socketServer';
import { emitPostEngagement, POST_ENGAGEMENT_EVENTS } from '../services/postEngagementBroadcast';
import { normalizeMediaItems, type NormalizedMediaItem } from '../utils/mediaInput';
import { warmLinkPreviewForText } from '../utils/linkPreviewWarm';
import { authorVariants, buildPrimaryVariant, resolveVariant, stripSpamHashtagBlocks, validateAuthorVariants } from '../services/postVariants';
import { postTranslationService, TranslationRequestError } from '../services/PostTranslationService';
import { validatePublicShareTarget } from '../utils/postAccessControl';
import { assertLaneAssignable, LaneAssignmentError } from '../utils/laneAssignment';
import {
  assertParentAcceptsReplies,
  ChannelReplyError,
  postIsAuthoredByChannel,
} from '../utils/channelReplyGate';
import type { AccountKind } from '@oxyhq/contracts';
import {
  assertCanPublishAsAccount,
  cacheAccountMemberReads,
  isChannelAccount,
  listOperatedChannelIds,
  PublishAsAccessError,
} from '../services/publishAsAccount';
import { listPostCorrections, recordPostCorrection } from '../db/posts/postCorrectionsRepository';
import { postManagementRefusal } from '../services/postManagementAccess';
import { sendSuccessResponse } from '../utils/apiHelpers';
import { sanitizePodcast, resolvePodcastContent } from '../utils/syraPodcast';
import {
  emitPostCreated,
  emitTombstone,
  postRecordUri,
} from '../services/mtn/MentionRecordEmitter';
import { postCollaborationService, CollabValidationError, CollabStateError } from '../services/PostCollaborationService';
import { resolveMcpAutoAcceptIds } from '../mcp/utils/resolveMcpAutoAcceptIds';
import { federateAsResolvedActor } from '../connectors/outboundFederation';
import { toFederationPostPayload } from '../services/serviceRegistry';
import { federatePostBatchDetached } from '../connectors/threadFederation';
import {
  EngagementPostNotFoundError,
  removeVoteCommand,
  savePostCommand,
  unsavePostCommand,
  votePostCommand,
} from '../services/PostEngagementCommandService';
import {
  BookmarkFolderInputError,
  type BookmarkFolderTarget,
  updateBookmarkFolderForViewer,
} from '../services/BookmarkFolderService';
import { repairRecentRepliersAfterPostDelete } from '../services/PostRecentReplierService';
import {
  allDeletionTargets,
  deletePostSubtree,
  PostDeletionTooLargeError,
  recordDeletionSideEffectFailure,
  repairSurvivingCounters,
  reportResidue,
  type DeletedPostSubtree,
  type PostDeletionTargets,
} from '../services/PostDeletionCascade';

import { loadScheduledChain } from '../services/scheduledChain';

/**
 * An article whose id is minted but whose row is not written yet.
 *
 * The post's content document has to carry `articleId`, and the article row must
 * not exist until the post it belongs to does — so the id is minted first and
 * the insert happens after the post succeeds. See `db/posts/articleRepository.ts`.
 */
interface PendingArticle {
  id: string;
  createdBy: string;
  title?: string;
  body?: string;
}

// Constants from centralized config
const MAX_SOURCES = config.posts.maxSources;
const MAX_SOURCE_TITLE_LENGTH = config.posts.maxSourceTitleLength;
const MAX_ARTICLE_TITLE_LENGTH = config.posts.maxArticleTitleLength;
const MAX_ARTICLE_EXCERPT_LENGTH = config.posts.maxArticleExcerptLength;
const DEFAULT_POLL_DURATION_DAYS = config.posts.defaultPollDurationDays;
const MAX_POLL_DURATION_DAYS = config.posts.maxPollDurationDays;
const MAX_HASHTAG_LENGTH = config.posts.maxHashtagLength;
const MAX_HASHTAGS_PER_POST = config.posts.maxHashtagsPerPost;
const MAX_EVENT_NAME_LENGTH = config.posts.maxEventNameLength;
const MAX_EVENT_LOCATION_LENGTH = config.posts.maxEventLocationLength;
const MAX_EVENT_DESCRIPTION_LENGTH = config.posts.maxEventDescriptionLength;
const DEFAULT_PAGE_SIZE = config.posts.defaultPageSize;
const MAX_PAGE_SIZE = config.posts.maxPageSize;
const DEFAULT_NEARBY_RADIUS_METERS = config.posts.defaultNearbyRadiusMeters;
const MAX_NEARBY_POSTS = config.posts.maxNearbyPosts;
/**
 * The both-location proximity read is allowed a wider page than the
 * single-location one, because a post can qualify through either point and the
 * union is therefore sparser per unit of scan. It was a bare `75` inline.
 */
const MAX_NEARBY_BOTH_LOCATIONS_POSTS = 75;

/**
 * The radius bound, as the index-usable spelling.
 *
 * `ST_DWithin(geo, point, metres)` is what the GiST index on the generated
 * `geography` column answers; `ST_Distance(...) <= metres` computes a distance
 * for every row in the table and cannot use it. `ST_MakePoint` takes LONGITUDE
 * FIRST, which is also the order the generated columns are built in — a
 * transposed pair yields a plausible point in the wrong hemisphere rather than
 * an error, so the order is stated once, here.
 */
function withinRadius(
  geoColumn: AnyPgColumn,
  longitude: number,
  latitude: number,
  radiusMeters: number,
): SQL {
  return sql`ST_DWithin(${geoColumn}, ST_MakePoint(${longitude}, ${latitude})::geography, ${radiusMeters})`;
}
const MAX_AREA_POSTS = config.posts.maxAreaPosts;
const DEFAULT_LIKES_LIMIT = config.posts.defaultLikesLimit;
const MAX_TEXT_LENGTH = config.posts.maxTextLength;

/**
 * Page size for the engagement lists (`GET /posts/:id/likes` and `.../boosts`).
 * Both handlers read the page's last row by index (`rows[limit - 1]`), so the
 * limit has to be a bounded positive integer: an absent, zero, or negative limit
 * would index outside the page and throw on the missing document.
 */
const clampLikesLimit = (limit: number | undefined): number =>
  Math.min(Math.max(limit || DEFAULT_LIKES_LIMIT, 1), MAX_PAGE_SIZE);

/**
 * Resolve the canonical Oxy {@link PostUser} for an engagement-list entry
 * (`GET /posts/:id/likes` and `GET /posts/:id/boosts`). Oxy owns identity, so the
 * response embeds the raw Oxy user (same shape as `post.user` / Who-to-follow):
 * `name.displayName`, `avatar` file id, `username`, `verified`, `isFederated`,
 * `federation`. When the resolver could not resolve a user, fall back to the
 * degraded user (neutral name, EMPTY username) — never the raw id as a handle,
 * which would render a ghost `@<oxyUserId>` and a broken profile link.
 */
const mapActorSummary = (
  userId: string,
  user: PostUser | undefined,
): PostUser => user ?? degradedActorSummary(userId);

const buildPostMetadata = (metadata: unknown): Record<string, unknown> => {
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
const sanitizeSources = (arr: unknown): { sources: Array<{ url: string; title?: string }>; error?: string } => {
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

const sanitizeArticle = (input: unknown): { title?: string; body?: string } | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title.trim().slice(0, MAX_ARTICLE_TITLE_LENGTH) : undefined;
  const body = typeof obj.body === 'string' ? obj.body.trim() : undefined;
  if (!title && !body) return undefined;
  return { ...(title ? { title } : {}), ...(body ? { body } : {}) };
};

const sanitizeEventData = (eventData: unknown): { eventId?: string; name?: string; date?: string; location?: string; description?: string } | null => {
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

const sanitizeRoomData = (roomData: unknown): { roomId: string; title: string; status?: string; topic?: string; host?: string } | null => {
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

const buildOrderedAttachments = ({
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

// Create a new post
export const createPost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { content, hashtags, mentions, quoted_post_id, boost_of, in_reply_to_status_id, parentPostId, threadId, contentLocation, postLocation, replyPermission, reviewReplies, quotesDisabled, status: incomingStatus, scheduledFor, collaboratorIds, collaboratorHandles, laneId, publishAsOxyUserId } = req.body;

    // Transitional request aliases are measured with a bounded label so their
    // retirement is evidence-based. They never become part of the stored DTO.
    if (!content?.media && content?.images) {
      metrics.incrementCounter('legacy_post_payload_total', 1, {
        variant: 'content-images',
      });
    } else if (!content?.media && !content?.images && req.body.media) {
      metrics.incrementCounter('legacy_post_payload_total', 1, {
        variant: 'top-level-media',
      });
    }
    if (content?.text == null && req.body.text != null) {
      metrics.incrementCounter('legacy_post_payload_total', 1, {
        variant: 'top-level-text',
      });
    }
    const media = content?.media || content?.images || req.body.media;
    const video = content?.video;
    const poll = content?.poll;
    const contentLocationData = content?.location || contentLocation;

    // The shared media set is resolved first: a language variant may localize the
    // alt text of these images, so validation needs to know which ids exist.
    const normalizedMedia = normalizeMediaItems(media);

    // Author language variants, in the order the composer sent them — the FIRST is
    // the primary. A composer that never opened the language UI sends none, and the
    // plain `content.text` below becomes the primary rendition (tagged with what the
    // classifier detects, never with the client's UI locale).
    const variantResult = validateAuthorVariants(content?.variants, normalizedMedia.map((item) => item.id));
    if (!variantResult.ok) {
      return res.status(400).json({ message: variantResult.error });
    }
    const authorLanguageVariants = variantResult.variants;

    const text = authorLanguageVariants[0]?.text ?? content?.text ?? req.body.text;

    // Validate text length
    if (text && typeof text === 'string' && text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ message: `Post text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` });
    }

    // Validate hashtags
    if (Array.isArray(hashtags)) {
      if (hashtags.length > MAX_HASHTAGS_PER_POST) {
        return res.status(400).json({ message: `Too many hashtags: maximum is ${MAX_HASHTAGS_PER_POST}` });
      }
      const invalidTag = hashtags.find((tag: unknown) =>
        typeof tag !== 'string' || tag.length > MAX_HASHTAG_LENGTH
      );
      if (invalidTag !== undefined) {
        return res.status(400).json({ message: `Invalid hashtag: each must be a string of at most ${MAX_HASHTAG_LENGTH} characters` });
      }
    }

    // Extract and merge hashtags from text with user-provided ones
    const uniqueTags = mergeHashtags(text || '', hashtags);

    // Process content location data (user's shared location)
    let processedContentLocation = null;
    if (contentLocationData) {
      let longitude, latitude, address;
      
      // Handle GeoJSON format: { type: 'Point', coordinates: [lng, lat], address?: string }
      if (contentLocationData.type === 'Point' && Array.isArray(contentLocationData.coordinates) && contentLocationData.coordinates.length === 2) {
        longitude = contentLocationData.coordinates[0];
        latitude = contentLocationData.coordinates[1];
        address = contentLocationData.address;
      }
      // Handle legacy format: { latitude: number, longitude: number, address?: string }
      else if (typeof contentLocationData.latitude === 'number' && typeof contentLocationData.longitude === 'number') {
        metrics.incrementCounter('legacy_post_payload_total', 1, {
          variant: 'content-location-object',
        });
        longitude = contentLocationData.longitude;
        latitude = contentLocationData.latitude;
        address = contentLocationData.address;
      }
      
      // Validate coordinates
      if (typeof longitude === 'number' && typeof latitude === 'number' &&
          latitude >= -90 && latitude <= 90 &&
          longitude >= -180 && longitude <= 180) {
        processedContentLocation = {
          type: 'Point' as const,
          coordinates: [longitude, latitude] as [number, number],
          address: address || undefined
        };
      } else {
        return res.status(400).json({ 
          error: 'Invalid location coordinates. Latitude must be between -90 and 90, longitude between -180 and 180.' 
        });
      }
    }

    // Process post location data (creation location metadata)
    let processedPostLocation = null;
    if (postLocation) {
      let longitude, latitude, address;
      
      // Handle GeoJSON format: { type: 'Point', coordinates: [lng, lat], address?: string }
      if (postLocation.type === 'Point' && Array.isArray(postLocation.coordinates) && postLocation.coordinates.length === 2) {
        longitude = postLocation.coordinates[0];
        latitude = postLocation.coordinates[1];
        address = postLocation.address;
      }
      // Handle legacy format: { latitude: number, longitude: number, address?: string }
      else if (typeof postLocation.latitude === 'number' && typeof postLocation.longitude === 'number') {
        metrics.incrementCounter('legacy_post_payload_total', 1, {
          variant: 'post-location-object',
        });
        longitude = postLocation.longitude;
        latitude = postLocation.latitude;
        address = postLocation.address;
        logger.debug('Received legacy format post location');
      }
      
      // Validate coordinates
      if (typeof longitude === 'number' && typeof latitude === 'number' &&
          latitude >= -90 && latitude <= 90 &&
          longitude >= -180 && longitude <= 180) {
        processedPostLocation = {
          type: 'Point' as const,
          coordinates: [longitude, latitude] as [number, number],
          address: address || undefined
        };
      } else {
        return res.status(400).json({ 
          error: 'Invalid post location coordinates. Latitude must be between -90 and 90, longitude between -180 and 180.' 
        });
      }
    }

    // Build complete content object. `text` is the API's convenience shape for a
    // single-language post; `PostCreationService` turns it into the primary variant
    // (nothing stores a second copy of the body).
    const postContent: PostContent = {
      text: text || '',
      media: normalizedMedia,
      ...(authorLanguageVariants.length > 0 ? { variants: authorLanguageVariants } : {}),
    };

    // Add video to media array if provided
    if (video) {
      if (!postContent.media) postContent.media = [];
      postContent.media.push({ id: video, type: 'video' });
    }

    // Create poll separately if provided and add pollId to content
    let pollId = null;
    if (poll) {
      // Validate poll endTime is in the future and within max duration
      if (poll.endTime) {
        const endTimeMs = new Date(poll.endTime).getTime();
        if (isNaN(endTimeMs)) {
          return res.status(400).json({ message: 'Invalid poll end time' });
        }
        if (endTimeMs <= Date.now()) {
          return res.status(400).json({ message: 'Poll end time must be in the future' });
        }
        const maxEndTimeMs = Date.now() + MAX_POLL_DURATION_DAYS * 24 * 60 * 60 * 1000;
        if (endTimeMs > maxEndTimeMs) {
          return res.status(400).json({ message: `Poll duration cannot exceed ${MAX_POLL_DURATION_DAYS} days` });
        }
      }

      try {
        // Postgres, through the shared writer. This used to `new Poll().save()`
        // into Mongo while `PostHydrationService` — the single DTO producer for
        // every post surface — reads polls from Postgres, so a poll created here
        // was written to one store and looked for in the other: the post said it
        // had a poll and rendered none.
        //
        // `postId` stays NULL until the post exists; the `temp_` placeholder the
        // Mongo code used is not portable to a real foreign key.
        pollId = await createPollWithOptions({
          question: poll.question,
          options: poll.options,
          createdBy: userId,
          endsAt: new Date(poll.endTime || Date.now() + DEFAULT_POLL_DURATION_DAYS * 24 * 60 * 60 * 1000),
          isMultipleChoice: poll.isMultipleChoice || false,
          isAnonymous: poll.isAnonymous || false,
        });
        postContent.pollId = pollId;
      } catch (pollError) {
        logger.error('Failed to create poll', pollError);
        return res.status(400).json({ message: 'Failed to create poll' });
      }
    }

    // Add location if provided
    if (processedContentLocation) {
      postContent.location = processedContentLocation;
    }

    const { sources, error: sourcesError } = sanitizeSources(content?.sources || req.body.sources);
    if (sourcesError) {
      return res.status(400).json({ message: sourcesError });
    }
    if (sources.length) {
      postContent.sources = sources;
    }

    const sanitizedArticle = sanitizeArticle(content?.article || req.body.article);
    let pendingArticle: PendingArticle | null = null;
    if (sanitizedArticle) {
      pendingArticle = {
        id: newArticleId(),
        createdBy: userId,
        title: sanitizedArticle.title || undefined,
        body: sanitizedArticle.body || undefined,
      };
      postContent.article = {
        articleId: pendingArticle.id,
        title: sanitizedArticle.title,
        excerpt: sanitizedArticle.body ? sanitizedArticle.body.slice(0, MAX_ARTICLE_EXCERPT_LENGTH) : undefined,
      };
    }

    // Handle event data
    const eventData = content?.event || req.body.event;
    const sanitizedEvent = sanitizeEventData(eventData);
    if (sanitizedEvent && sanitizedEvent.name && sanitizedEvent.date) {
      postContent.event = sanitizedEvent as import('@mention/shared-types').PostEventContent;
    }

    // Handle room data
    const roomData = content?.room || req.body.room;
    const sanitizedRoom = sanitizeRoomData(roomData);
    if (sanitizedRoom) {
      postContent.room = sanitizedRoom as import('@mention/shared-types').PostRoomContent;
    }

    // Handle podcast data: a single Syra podcast show attached to the post. The
    // client only sends an untrusted `{ syraPodcastId }` reference; the canonical
    // title/author/artwork and show URL are resolved + denormalized server-side
    // from the Syra catalog via @syra.fm/sdk — never trusted from the client.
    const sanitizedPodcast = sanitizePodcast(content?.podcast || req.body.podcast);
    if (sanitizedPodcast) {
      try {
        postContent.podcast = await resolvePodcastContent(sanitizedPodcast.syraPodcastId);
      } catch (podcastError) {
        logger.warn('Failed to resolve Syra podcast for post', { userId, syraPodcastId: sanitizedPodcast.syraPodcastId, error: podcastError });
        return res.status(400).json({ message: 'Unable to resolve the selected podcast' });
      }
    }

    const attachmentsInput = content?.attachments || content?.attachmentOrder || req.body.attachments || req.body.attachmentOrder;
    const computedAttachments = buildOrderedAttachments({
      rawAttachments: attachmentsInput || postContent.attachments,
      media: Array.isArray(postContent.media) ? postContent.media : [],
      includePoll: Boolean(postContent.pollId),
      includeArticle: Boolean(postContent.article),
      includeEvent: Boolean(postContent.event),
      includeRoom: Boolean(postContent.room),
      includeLocation: Boolean(postContent.location),
      includeSources: Boolean(postContent.sources && postContent.sources.length),
      includePodcast: Boolean(postContent.podcast)
    });

    if (computedAttachments) {
      postContent.attachments = computedAttachments;
    } else {
      delete postContent.attachments;
    }

    let postStatus: 'draft' | 'published' | 'scheduled' = 'published';
    let scheduledForDate: Date | null = null;

    if (scheduledFor) {
      const parsed = new Date(scheduledFor);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ message: 'Invalid scheduled time' });
      }
      if (parsed.getTime() <= Date.now()) {
        return res.status(400).json({ message: 'Scheduled time must be in the future' });
      }
      postStatus = 'scheduled';
      scheduledForDate = parsed;
    } else if (incomingStatus === 'draft') {
      postStatus = 'draft';
    } else if (incomingStatus === 'scheduled') {
      return res.status(400).json({ message: 'scheduledFor is required when scheduling a post' });
    }

    const postMetadata = buildPostMetadata(req.body.metadata);

    if (quoted_post_id) {
      const quotedPost = await loadPostRecord(String(quoted_post_id));
      const quoteValidation = validatePublicShareTarget(quotedPost, { action: 'quote' });
      if (!quoteValidation.ok) {
        return res.status(quoteValidation.status).json({ message: quoteValidation.message });
      }
    }

    if (boost_of) {
      const boostedPost = await loadPostRecord(String(boost_of));
      const boostValidation = validatePublicShareTarget(boostedPost, { action: 'boost' });
      if (!boostValidation.ok) {
        return res.status(boostValidation.status).json({ message: boostValidation.message });
      }
    }

    // A CHANNEL POST TAKES NO REPLIES — and this is the path where that has to be
    // enforced from scratch. `POST /posts` will happily create a reply when the
    // body carries `parentPostId` / `in_reply_to_status_id`, and it looks the
    // parent up NOWHERE: the two validations above cover `quoted_post_id` and
    // `boost_of` only. There is no reply-permission check on this route at all, so
    // there is nothing here to hang the gate off — it needs its own lookup, or the
    // refusal in `feed.controller.createReply` is a front door with the back one
    // open.
    const replyTargetId = parentPostId || in_reply_to_status_id;
    if (replyTargetId) {
      await assertParentAcceptsReplies(String(replyTargetId));
    }

    const rawVisibility = typeof req.body.visibility === 'string' ? req.body.visibility : undefined;
    let resolvedVisibility = PostVisibility.PUBLIC;
    if (rawVisibility === 'followers' || rawVisibility === 'followers_only') {
      resolvedVisibility = PostVisibility.FOLLOWERS_ONLY;
    } else if (rawVisibility === 'private') {
      resolvedVisibility = PostVisibility.PRIVATE;
    } else if (rawVisibility === 'public') {
      resolvedVisibility = PostVisibility.PUBLIC;
    }

    const invitedCollaboratorIds = await postCollaborationService.resolveCollaboratorRefs(
      userId,
      Array.isArray(collaboratorIds) ? collaboratorIds : undefined,
      Array.isArray(collaboratorHandles) ? collaboratorHandles : undefined,
    );
    const autoAcceptCollaboratorIds = await resolveMcpAutoAcceptIds(req, invitedCollaboratorIds);

    const post = await postCreationService.create({
      oxyUserId: userId,
      content: postContent,
      location: processedPostLocation,
      hashtags: uniqueTags,
      mentions: mentions || [],
      collaboratorIds: invitedCollaboratorIds,
      autoAcceptCollaboratorIds,
      quoteOf: quoted_post_id || null,
      boostOf: boost_of || null,
      // Validated inside `create` (see `assertLaneAssignable`): a lane the author
      // does not own is a 404, and one on a reply or a boost is a 400 — both
      // refusals, never a silent drop.
      laneId: typeof laneId === 'string' ? laneId : null,
      // Validated inside `create` (see `assertCanPublishAsAccount`): an account
      // the caller is not an active member of is a 403, an act-as-eligible one
      // they hold no `account:act_as` over is a 403, and a personal account is a
      // 400 — all refusals, never a silent drop, and all raised before anything is
      // written. `create` is also where the post picks up that account as its
      // AUTHOR, the writer as `writtenByOxyUserId`, and (for a channel)
      // `replyPermission: ['nobody']`, so no caller can route around any of it.
      publishAsOxyUserId: typeof publishAsOxyUserId === 'string' ? publishAsOxyUserId : null,
      memberReader: createUserScopedOxyServices(req),
      parentPostId: parentPostId || in_reply_to_status_id || null,
      threadId: threadId || null,
      visibility: resolvedVisibility,
      replyPermission: replyPermission || ['anyone'],
      reviewReplies: reviewReplies || false,
      quotesDisabled: quotesDisabled || false,
      status: postStatus,
      scheduledFor: scheduledForDate || undefined,
      metadata: postMetadata,
      senderUsername: req.user?.username,
    });

    if (pendingArticle) {
      try {
        await insertArticle({ ...pendingArticle, postId: post.id });
      } catch (articleError) {
        logger.error('Failed to save article content', articleError);
      }
    }

    if (pollId) {
      try {
        await attachPollToPost(pollId, post.id);
      } catch (pollUpdateError) {
        logger.error('Failed to update poll postId', pollUpdateError);
      }
    }

    // Affinity graph: a quote / reply created via POST /posts expresses affinity
    // from the author toward the quoted / replied-to post's author. Fire-and-
    // forget — buffering must never block or fail post creation. Only published
    // (non-draft/non-scheduled) posts emit; a quote and a reply are independent
    // (a post can be both). Resolve the target author with a lean lookup.
    if (postStatus === 'published') {
      const parentIdForAffinity = parentPostId || in_reply_to_status_id;
      const affinityTargets: Array<{ targetPostId: string; type: 'quote' | 'reply' }> = [];
      if (quoted_post_id) affinityTargets.push({ targetPostId: String(quoted_post_id), type: 'quote' });
      if (parentIdForAffinity) affinityTargets.push({ targetPostId: String(parentIdForAffinity), type: 'reply' });

      for (const { targetPostId, type } of affinityTargets) {
        void (async () => {
          const target = await loadPostRecord(targetPostId);
          const targetAuthorId = target?.oxyUserId;
          if (!targetAuthorId) return;
          await affinityEventService.record({
            fromUserId: userId,
            toUserId: targetAuthorId,
            type,
            eventId: `${type}:${post.id}`,
          });
        })().catch(() => undefined);
      }
    }

    await warmLinkPreviewForText(resolveVariant(post.content).text);

    const [hydratedPost] = await postHydrationService.hydratePosts([post], {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    if (!hydratedPost) {
      return res.status(500).json({ message: 'Post created but could not be hydrated' });
    }

    res.status(201).json({ success: true, post: hydratedPost });
  } catch (error) {
    if (error instanceof CollabValidationError) {
      return res.status(400).json({ message: error.message });
    }
    if (error instanceof LaneAssignmentError) {
      return res.status(error.status).json({ message: error.message });
    }
    if (error instanceof ChannelReplyError || error instanceof PublishAsAccessError) {
      return res.status(error.status).json({ message: error.message });
    }
    logger.error('Error creating post', error);
    res.status(500).json({ message: 'Error creating post' });
  }
};

// Accept a collaboration invite
export const acceptCollabInvite = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const post = await postCollaborationService.accept(String(req.params.id), userId);
    const [hydratedPost] = await postHydrationService.hydratePosts([post], {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });
    return res.status(200).json({ success: true, post: hydratedPost ?? null });
  } catch (error) {
    if (error instanceof CollabStateError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('Error accepting collab invite', error);
    return res.status(500).json({ message: 'Error accepting collaboration invite' });
  }
};

export const declineCollabInvite = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const post = await postCollaborationService.decline(String(req.params.id), userId);
    // Return the fully-hydrated post (same as accept/stop-sharing) so the client
    // can update its cached copy: the viewer's authorship entry is now `declined`,
    // which flips the invite notification from actionable buttons to a resolved
    // state. For a private/followers-only post the decliner loses view access, so
    // hydration yields no post and the client simply drops the actionable UI.
    const [hydratedPost] = await postHydrationService.hydratePosts([post], {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });
    return res.status(200).json({ success: true, post: hydratedPost ?? null });
  } catch (error) {
    if (error instanceof CollabStateError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('Error declining collab invite', error);
    return res.status(500).json({ message: 'Error declining collaboration invite' });
  }
};

export const stopCollabSharing = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const post = await postCollaborationService.stopSharing(String(req.params.id), userId);
    const [hydratedPost] = await postHydrationService.hydratePosts([post], {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });
    return res.status(200).json({ success: true, post: hydratedPost ?? null });
  } catch (error) {
    if (error instanceof CollabStateError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('Error stopping collab sharing', error);
    return res.status(500).json({ message: 'Error stopping collaboration sharing' });
  }
};

// Create a thread of posts
export const createThread = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Both modes are schedulable, and they are schedulable for different
    // reasons. Beast posts are independent — nothing chains to anything — so
    // scheduling them is n independent scheduled posts. A THREAD is a chain:
    // each continuation is created with its predecessor as `parentPostId`, so
    // publishing them separately could let a reply go live before the post it
    // answers. That is not solved here but in the publish path, where it belongs:
    // `claimAndPublishScheduledPost` refuses a post whose parent has not
    // published, and `ScheduledPostPublisher` walks each chain parent-first and
    // stops at its first failure. See `services/scheduledChain.ts` for why the
    // invariant survives a partial failure.
    const wantsSchedule = Boolean(req.body.status || req.body.scheduledFor);

    let threadScheduledFor: Date | null = null;
    if (wantsSchedule) {
      // The SAME two checks `POST /posts` applies, deliberately: a beast batch
      // must not be schedulable on terms a single post is not.
      if (!req.body.scheduledFor) {
        return res.status(400).json({ message: 'scheduledFor is required when scheduling a post' });
      }
      const parsed = new Date(req.body.scheduledFor);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ message: 'Invalid scheduled time' });
      }
      if (parsed.getTime() <= Date.now()) {
        return res.status(400).json({ message: 'Scheduled time must be in the future' });
      }
      threadScheduledFor = parsed;
    }

    // Collaborative authorship is a single-post feature; a thread has no single
    // owner/collaborator surface, so reject any collaborator invites up front
    // (both the top-level field and any per-post field) rather than silently
    // dropping them.
    const threadHasCollaborators =
      (Array.isArray(req.body.collaboratorIds) && req.body.collaboratorIds.length > 0) ||
      (Array.isArray(req.body.posts) &&
        req.body.posts.some(
          (p: { collaboratorIds?: unknown }) =>
            Array.isArray(p?.collaboratorIds) && p.collaboratorIds.length > 0,
        ));
    if (threadHasCollaborators) {
      return res.status(400).json({ message: 'Collaborators are not supported on threads' });
    }

    const { mode, posts } = req.body;
    logger.debug('Creating thread', {
      mode,
      postCount: Array.isArray(posts) ? posts.length : 0,
    });

    if (!Array.isArray(posts) || posts.length === 0) {
      return res.status(400).json({ message: 'Posts array is required and cannot be empty' });
    }

    // WHO PUBLISHES WHAT, in both modes.
    //
    // A `beast` batch is n independent top-level posts, so the account is PER
    // ENTRY and the batch-level field is refused — there is no batch to speak of.
    //
    // A `thread` takes BOTH, with per-entry winning: the batch-level field is the
    // thread's account, and an entry may name its own. Those two shapes are
    // different threads, not two spellings of one, which is why both exist:
    //
    //   - ONE account for the whole thread — one text in several parts. This is
    //     the only shape available to a CHANNEL, and it is what `channelReplyGate`
    //     leaves room for.
    //   - DIFFERENT accounts per entry — two organizations the caller operates,
    //     talking to each other. Mechanically each such entry REPLIES to the one
    //     before it, so this is a conversation between accounts, and a channel may
    //     never be in one: "no replies, ever" has no exception for a channel's own
    //     operators. Hence the single-voice rule enforced below.
    //
    // The links are stored as replies to their predecessor, which is what joins a
    // thread at all, and `PostCreationService` normally refuses to publish a reply
    // as another account. The two exceptions are `continuesOwnThread` and
    // `answersOperatedAccount` on the create call below, both VERIFIED against the
    // database rather than asserted — see `utils/threadContinuation`. Nothing here
    // opens any account's posts to replies from a third party: every entry is
    // authored by one of the caller's own accounts, so the reply gate refuses
    // everybody else on a continuation exactly as it does on the root.
    const batchAccount = req.body.publishAsOxyUserId;
    if (mode !== 'thread' && typeof batchAccount === 'string') {
      return res
        .status(400)
        .json({ message: 'Set publishAsOxyUserId on each post, not on the thread' });
    }

    // Every DISTINCT account named across the batch is authorized ONCE, before a
    // single post is written — the same shape the collaborator and lane refusals
    // take, and for the same reason (a partial thread cannot be undone in one
    // action). In thread mode that is literally one call for the whole request;
    // in beast mode `cacheAccountMemberReads` is what makes it one MEMBERSHIP READ
    // per distinct account, since the creation loop below hands every post the
    // SAME reader and lets `PostCreationService` run the real gate itself, so
    // nothing routes around the authorization.
    const memberReader = createUserScopedOxyServices(req);
    const batchMemberReader = memberReader ? cacheAccountMemberReads(memberReader) : undefined;
    /**
     * The account THIS request names for an entry, if any. In thread mode the
     * entry's own field wins and the batch-level one is the default for entries
     * that name none; in beast mode there is no batch-level field to fall back to.
     */
    const accountForEntry = (index: number): string | null => {
      const named = (posts[index] as { publishAsOxyUserId?: unknown })?.publishAsOxyUserId;
      if (typeof named === 'string') return named;
      return mode === 'thread' && typeof batchAccount === 'string' ? batchAccount : null;
    };

    /** Entry index → the account that entry will be AUTHORED BY. */
    const entryAuthorIds: string[] = [];
    /** That account's Oxy kind, `null` when the entry is the caller's own post. */
    const entryAuthorKinds: Array<AccountKind | null> = [];
    try {
      // Authorized once per DISTINCT account, memoized across the batch: a thread
      // naming one account asks Oxy once however many entries it has, and one
      // naming two asks twice. `cacheAccountMemberReads` is what makes that true
      // end to end, since the creation loop below hands every post the SAME reader
      // and lets `PostCreationService` run the real gate itself — nothing routes
      // around the authorization.
      const decided = new Map<string, { authorId: string | null; authorKind: AccountKind | null }>();
      for (let i = 0; i < posts.length; i++) {
        const requested = accountForEntry(i);
        const key = requested ?? '';
        let decision = decided.get(key);
        if (!decision) {
          decision = await assertCanPublishAsAccount({
            publishAsOxyUserId: requested,
            callerId: userId,
            memberReader: batchMemberReader,
          });
          decided.set(key, decision);
        }
        entryAuthorIds.push(decision.authorId ?? userId);
        entryAuthorKinds.push(decision.authorKind);
      }
    } catch (publishAsError) {
      if (publishAsError instanceof PublishAsAccessError) {
        return res.status(publishAsError.status).json({ message: publishAsError.message });
      }
      throw publishAsError;
    }

    // A CHANNEL'S THREAD SPEAKS WITH ONE VOICE.
    //
    // A thread carrying more than one account is a conversation between them —
    // every entry whose account differs from its predecessor's is that account
    // REPLYING to the other's post. A channel may not be in one, at either end,
    // and that is not a preference: `utils/channelReplyGate` refuses replies to a
    // channel's post at five write sites with no exception for the channel's own
    // operators, so admitting it here would reopen exactly that door from inside
    // the composer.
    //
    // Checked over the WHOLE thread rather than pairwise, because a channel at the
    // head makes every later entry an answer to a channel whichever post is the
    // immediate parent — and because a channel in the middle is the same problem
    // read from the other side. The message names the channel, since "you cannot
    // do that" without saying which of several accounts is the obstacle is a
    // refusal nobody can act on.
    const distinctThreadAccounts = new Set(entryAuthorIds);
    if (mode === 'thread' && distinctThreadAccounts.size > 1) {
      const channelIndex = entryAuthorKinds.findIndex((kind) => kind === 'channel');
      if (channelIndex >= 0) {
        return res.status(400).json({
          message:
            'A channel publishes alone: a thread including ' +
            `${entryAuthorIds[channelIndex]} must use that one account for every post, ` +
            'because a post from another account would be a reply to the channel.',
        });
      }
    }
    /**
     * Whether this thread is one account's own text (every entry the same) rather
     * than several accounts talking. It decides which of the two verified
     * exceptions each link below is created under, and the two are NOT
     * interchangeable — a channel may only ever use the first.
     */
    const threadSpeaksWithOneVoice = distinctThreadAccounts.size === 1;

    // Lanes are validated for the WHOLE batch before a single post is written.
    // The loop below creates posts one at a time, so a lane refused on entry 3
    // would otherwise leave entries 1 and 2 already published — a half-thread
    // nobody asked for and nobody can undo in one action.
    //
    // In THREAD mode only the root takes a lane: its continuations are replies,
    // and the feed renders the whole thread as one slice anchored on that root,
    // so the chip appears once and in the right place. A continuation that
    // carries one is refused with the same message the shared validator would
    // give it. In BEAST mode every entry is an independent top-level post, so
    // every entry may carry its own lane.
    for (let i = 0; i < posts.length; i++) {
      // Narrowed with `typeof`, matching what the creation loop below passes to
      // `PostCreationService`. Without it a NON-string `laneId` (a number, say)
      // reaches the pre-flight as-is and 404s, while the create call narrows it to
      // `null` and drops it silently — two different answers to one request,
      // depending on which of the two read it.
      const requestedLaneId = typeof posts[i]?.laneId === 'string' ? posts[i].laneId : undefined;
      if (!requestedLaneId) continue;
      if (mode === 'thread' && i > 0) {
        return res.status(400).json({ message: 'A reply cannot be assigned to a lane' });
      }
      try {
        // Against the entry's OWN author, which is the account it is published as
        // when it names one — a lane belongs to a publisher, and `create` will
        // measure it against exactly that. Checking the caller here instead would
        // let a caller-owned lane on an account-published entry pass the
        // pre-flight and then be refused mid-batch, which is the half-thread this
        // whole loop exists to prevent.
        await assertLaneAssignable({ laneId: requestedLaneId, authorId: entryAuthorIds[i] });
      } catch (laneError) {
        if (laneError instanceof LaneAssignmentError) {
          return res.status(laneError.status).json({ message: laneError.message });
        }
        throw laneError;
      }
    }

    /**
     * Each entry's author-written language renditions, PRIMARY FIRST — validated
     * for the whole batch before a single row is written, like every other
     * refusal above, because a variant rejected on entry 3 would otherwise leave
     * entries 1 and 2 already published.
     *
     * The creation loop reads the validated array from here rather than
     * revalidating, so the batch cannot be checked under one set of rules and
     * written under another. An entry that sent no variants yields an empty
     * array and its plain `content.text` stays the body, exactly as before.
     */
    const entryVariants: PostContentVariant[][] = [];
    for (const entry of posts) {
      // The shared media set the variants localize — resolved the same way the
      // creation loop resolves it, so a variant may only override alt text for
      // media the entry actually carries.
      const entryMediaIds = normalizeMediaItems(entry?.content?.media).map((item) => item.id);
      const variantResult = validateAuthorVariants(entry?.content?.variants, entryMediaIds);
      if (!variantResult.ok) {
        return res.status(400).json({ message: variantResult.error });
      }
      entryVariants.push(variantResult.variants);
    }

    /**
     * The created posts, in publication order — read by hydration AND by outbound
     * federation. ONE array, not two: a `PostRecord` is the row as a value, so
     * there is no live document beside it for federation to stamp — it re-reads
     * and returns the updated record instead.
     */
    const createdPostObjects: PostRecord[] = [];
    let mainPostId: string | null = null;
    let previousPostId: string | null = null;

    for (let i = 0; i < posts.length; i++) {
      const postData = posts[i];
      const { content, hashtags, mentions, visibility, replyPermission, reviewReplies, quotesDisabled, metadata } = postData;

      // Process content location data
      let processedContentLocation = null;
      if (content?.location) {
        const locationData = content.location;
        let longitude, latitude, address;
        
        if (locationData.type === 'Point' && Array.isArray(locationData.coordinates)) {
          longitude = locationData.coordinates[0];
          latitude = locationData.coordinates[1];
          address = locationData.address;
        }
        
        if (typeof longitude === 'number' && typeof latitude === 'number' &&
            latitude >= -90 && latitude <= 90 &&
            longitude >= -180 && longitude <= 180) {
          processedContentLocation = {
            type: 'Point' as const,
            coordinates: [longitude, latitude] as [number, number],
            address: address || undefined
          };
        }
      }

      // Build post content. When the entry carries author language renditions the
      // FIRST is the primary and its text IS the body — the same rule
      // `POST /posts` applies, and the reason the plain `content.text` is only a
      // fallback: a multilingual entry that stored `content.text` instead would
      // lose every rendition it was written in.
      const authorLanguageVariants = entryVariants[i];
      const postContent: PostContent = {
        text: authorLanguageVariants[0]?.text ?? content?.text ?? '',
        media: normalizeMediaItems(content?.media),
        ...(authorLanguageVariants.length > 0 ? { variants: authorLanguageVariants } : {}),
      };

      if (processedContentLocation) {
        postContent.location = processedContentLocation;
      }

      const { sources } = sanitizeSources(content?.sources);
      if (sources.length) {
        postContent.sources = sources;
      }

      // An article belongs to the ENTRY that carries one, in both modes. This was
      // read from the root only, so a beast batch — n independent posts that share
      // nothing but the action that wrote them — silently discarded the article on
      // every box but the first, and a thread did the same to a continuation.
      // `POST /posts` puts no such condition on it (a reply may carry an article),
      // so there was never a rule here, only a missing loop.
      let pendingArticle: PendingArticle | null = null;
      const sanitizedArticle = sanitizeArticle(content?.article);
      if (sanitizedArticle) {
        pendingArticle = {
          id: newArticleId(),
          createdBy: userId,
          title: sanitizedArticle.title || undefined,
          body: sanitizedArticle.body || undefined,
        };
        postContent.article = {
          articleId: pendingArticle.id,
          title: sanitizedArticle.title,
          excerpt: sanitizedArticle.body ? sanitizedArticle.body.slice(0, MAX_ARTICLE_EXCERPT_LENGTH) : undefined,
        };
      }

      // Handle event data
      const threadSanitizedEvent = sanitizeEventData(content?.event);
      if (threadSanitizedEvent && threadSanitizedEvent.name && threadSanitizedEvent.date) {
        postContent.event = threadSanitizedEvent as import('@mention/shared-types').PostEventContent;
      }

      // Handle room data
      const threadSanitizedRoom = sanitizeRoomData(content?.room);
      if (threadSanitizedRoom) {
        postContent.room = threadSanitizedRoom as import('@mention/shared-types').PostRoomContent;
      }

      // Handle podcast data: verify + denormalize the Syra show server-side (as
      // in createPost). The thread path is best-effort and never aborts the loop
      // mid-creation, so an unresolvable show is dropped (logged) rather than
      // 400'd — matching how the article/event/room attachments behave here.
      const threadSanitizedPodcast = sanitizePodcast(content?.podcast);
      if (threadSanitizedPodcast) {
        try {
          postContent.podcast = await resolvePodcastContent(threadSanitizedPodcast.syraPodcastId);
        } catch (podcastError) {
          logger.warn('Failed to resolve Syra podcast for thread post; dropping', { userId, syraPodcastId: threadSanitizedPodcast.syraPodcastId, error: podcastError });
        }
      }

      // Handle poll creation
      let pollId = null;
      if (content?.poll) {
        const poll = content.poll;
        // Same shared writer as the single-post path above. The previous call
        // here also passed fields the poll schema never had (`endTime`, `votes`,
        // `userVotes`) and bare option strings where the single-post path passed
        // `{ text }` — two spellings of one write, which is what having no
        // shared writer buys.
        pollId = await createPollWithOptions({
          question: poll.question || 'Poll',
          options: poll.options ?? [],
          createdBy: userId,
          endsAt: new Date(poll.endTime || Date.now() + DEFAULT_POLL_DURATION_DAYS * 24 * 60 * 60 * 1000),
          isMultipleChoice: poll.isMultipleChoice || false,
          isAnonymous: poll.isAnonymous || false,
        });
        postContent.pollId = pollId;
      }

      // Extract and merge hashtags from text with user-provided ones. Read off the
      // body that is actually stored (the primary rendition when the entry has
      // renditions), or a multilingual entry's tags would come from a string
      // nobody will ever see.
      const uniqueTags = mergeHashtags(postContent.text ?? '', hashtags);

      // Create post
      const attachmentsInput = content?.attachments || content?.attachmentOrder || postData.attachments || postData.attachmentOrder;
      const computedAttachments = buildOrderedAttachments({
        rawAttachments: attachmentsInput || postContent.attachments,
        media: Array.isArray(postContent.media) ? postContent.media : [],
        includePoll: Boolean(postContent.pollId),
        includeArticle: Boolean(postContent.article),
        includeEvent: Boolean(postContent.event),
        includeRoom: Boolean(postContent.room),
        includeLocation: Boolean(postContent.location),
        includeSources: Boolean(postContent.sources && postContent.sources.length),
        includePodcast: Boolean(postContent.podcast)
      });

      if (computedAttachments) {
        postContent.attachments = computedAttachments;
      } else {
        delete postContent.attachments;
      }

      // Route every thread post through PostCreationService so Stage-A
      // classification AND the MTN dual-write (signed `app.mention.feed.post`
      // record per thread post, with reply.root/reply.parent for continuations)
      // live in ONE place. The thread keeps its own per-post mention
      // notifications and its own single main-post socket emit below, so we
      // suppress PCS's notification/socket/federation stages to preserve the
      // EXACT pre-existing side-effect behavior (the response is byte-identical).
      const isThreadContinuation = mode === 'thread' && i > 0 && Boolean(previousPostId);
      const post = await postCreationService.create({
        oxyUserId: userId,
        content: postContent,
        hashtags: uniqueTags,
        mentions: mentions || [],
        visibility: (visibility as PostVisibility) || PostVisibility.PUBLIC,
        replyPermission: replyPermission || ['anyone'],
        reviewReplies: reviewReplies || false,
        quotesDisabled: quotesDisabled || false,
        metadata: buildPostMetadata(metadata),
        // Already validated for the whole batch above; a continuation never
        // reaches here carrying one.
        laneId: typeof postData.laneId === 'string' ? postData.laneId : null,
        // Pre-flighted for the whole batch above, and re-run HERE by `create`
        // itself — deliberately, not wastefully. The gate is the one place that
        // decides the author, so passing a pre-resolved id instead would be the
        // "checked upstream, trust me" shape that lets a later caller route around
        // it. The repeat is free: `batchMemberReader` has already answered for this
        // account. In thread mode the account is the batch's, applied to every
        // entry; in beast mode it is the entry's own.
        publishAsOxyUserId: accountForEntry(i),
        memberReader: batchMemberReader,
        // For thread mode: chain each continuation post to the immediately
        // previous post (sequential thread), with a shared threadId root.
        // For beast mode: all posts are independent.
        ...(isThreadContinuation ? { parentPostId: previousPostId, threadId: mainPostId } : {}),
        // The two verified exceptions to "a reply cannot be published as another
        // account", and the ONLY place either is ever asked for. Which one this
        // link gets is decided by the THREAD, not by the adjacent pair: a
        // single-voice thread is one account's own text end to end, and anything
        // else is accounts talking. Asking for the wrong one is safe — both are
        // re-derived from the database inside `create`, so a mismatch is a
        // refusal, never a bypass.
        //
        // Safe to ask for here for a structural reason rather than a trusting
        // one: `previousPostId` and `mainPostId` are ids of posts THIS request
        // created moments ago under the authorization above. See
        // `utils/threadContinuation`.
        ...(isThreadContinuation
          ? threadSpeaksWithOneVoice
            ? { continuesOwnThread: true }
            : { answersOperatedAccount: true }
          : {}),
        // Every post of a scheduled batch carries the SAME time — the author
        // picked one moment for the set, not n moments. For a beast batch each
        // is then an ordinary scheduled post published independently; for a
        // thread the shared time is what lets the sweep pick the whole chain up
        // on one tick and publish it in order.
        ...(threadScheduledFor
          ? { status: 'scheduled' as const, scheduledFor: threadScheduledFor }
          : {}),
        skipNotifications: true,
        skipSocketEmit: true,
        skipFederationDelivery: true,
      });

      // Thread mode: the ROOT post (i === 0) anchors the thread on its OWN id so
      // the whole self-thread — root included — shares one threadId. This is what
      // lets ThreadSlicingService recognise the root (threadId set, no
      // parentPostId) and pull its same-author continuations into a single
      // connected slice; without it the root never matches and the thread renders
      // as loose posts. The id is only available after creation, so anchor it with
      // a follow-up update. (This native self-thread marker is NOT part of the MTN
      // post record — the root's signed record is correctly a top-level post.)
      let anchored = post;
      if (mode === 'thread' && i === 0 && posts.length > 1) {
        await updatePostRecord(post.id, { threadId: post.id });
        anchored = { ...post, threadId: post.id };
      }

      if (pendingArticle) {
        try {
          await insertArticle({ ...pendingArticle, postId: anchored.id });
        } catch (articleError) {
          logger.error('Failed to save article content (thread)', articleError);
        }
      }

      // Mentions per post in thread. Read the reconciled persisted allowlist,
      // never the raw request metadata: an orphan id must not notify anyone.
      // A SCHEDULED post has not gone out, so nobody has been mentioned yet —
      // `publishScheduledPost` runs this same notification stage at the moment it
      // does. Notifying here would point people at a post they cannot read.
      try {
        // A scheduled thread notifies NOBODY yet, per the note above.
        if (!threadScheduledFor && anchored.mentions.length > 0) {
          await createMentionNotifications(
            anchored.mentions,
            anchored.id,
            // The ACTOR is the post's author, read off the row `create` just
            // wrote — the account when the entry was published as one, the caller
            // otherwise. `PostCreationService` attributes its own mention
            // notifications the same way; naming the caller here would put a
            // channel's writer in the notification of a post the channel signed,
            // which is the anonymity `writtenByOxyUserId` exists to keep.
            anchored.oxyUserId ?? userId,
            'post'
          );
        }
      } catch (e) {
        logger.error('Failed to create mention notifications (thread)', e);
      }

      // Update poll's postId
      if (pollId) {
        await attachPollToPost(pollId, anchored.id);
      }

      // Store the first post ID as the main post for thread linking
      if (i === 0) {
        mainPostId = anchored.id;
      }

      // Track the latest post so the next iteration chains onto it
      previousPostId = anchored.id;

      createdPostObjects.push(anchored);
    }

    // Outbound federation for the whole batch, detached, walking the chain
    // parent-first. This is the half `skipNotifications` above removes: that
    // flag returns from `PostCreationService.create` BEFORE its side-effect
    // stage, and federation lives inside that stage — which is why a published
    // thread federated nothing while the same thread scheduled federated
    // completely, since the scheduled publisher runs the full pipeline per entry
    // when its time arrives.
    //
    // A SCHEDULED batch is skipped for exactly that reason: its entries are not
    // published, nobody may read them yet, and `ScheduledPostPublisher` will
    // federate each one at the moment it goes live. Federating here would
    // announce a post the ACL still refuses.
    //
    // Detached on purpose — each entry's fan-out runs the SSRF guard (which
    // resolves DNS) once per target inbox, so awaiting it would put
    // `entries × inboxes` lookups in front of the response. See
    // `connectors/threadFederation.ts` for the ordering and consent rules.
    if (!threadScheduledFor) {
      federatePostBatchDetached({
        entries: createdPostObjects,
        shape: mode === 'thread' ? 'chain' : 'independent',
      });
    }

    await Promise.all(
      createdPostObjects.map((p) => warmLinkPreviewForText(resolveVariant(p.content).text)),
    );

    const createdPosts = await postHydrationService.hydratePosts(createdPostObjects, {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    logger.info(`Created ${createdPosts.length} posts in ${mode} mode`);

    // Emit real-time feed update for new thread posts. A SCHEDULED batch emits
    // nothing: the posts are not readable yet, so pushing them into live feeds
    // would show subscribers a post the ACL then refuses. Each one emits for
    // itself when the publisher runs it.
    try {
      const io = getRuntimeSocketServer();
      if (io && !threadScheduledFor && createdPosts.length > 0) {
        // Emit the first post (main post) to feeds
        const mainPost = createdPosts[0];
        io.emit('feed:updated', {
          type: 'for_you',
          post: mainPost,
          timestamp: new Date().toISOString()
        });
        io.emit('feed:updated', {
          type: 'following',
          post: mainPost,
          // The FIRST entry's author, which is who a following feed would have to
          // follow to see it — the account when that entry was published as one.
          // Naming the caller would push an account's post into the feeds of the
          // caller's followers, who may not follow the account at all.
          authorId: entryAuthorIds[0] ?? userId,
          timestamp: new Date().toISOString()
        });
      }
    } catch (socketError) {
      logger.warn('Failed to emit socket event for new thread', socketError);
    }

    res.status(201).json({ success: true, posts: createdPosts });
  } catch (error) {
    logger.error('Error creating thread', error);
    res.status(500).json({ message: 'Error creating thread' });
  }
};

// Get all posts
export const getPosts = async (req: AuthRequest, res: Response) => {
  try {
    const page = queryInt(req.query.page) || 1;
    const limit = Math.min(queryInt(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const currentUserId = req.user?.id;

    const posts = await findPostRecords(
      and(eq(postsTable.visibility, 'public'), eq(postsTable.status, 'published')),
      { orderBy: CHRONO_DESC, limit, offset: (page - 1) * limit },
    );

    const hydratedPosts = await postHydrationService.hydratePosts(posts, {
      viewerId: currentUserId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    res.json({
      posts: hydratedPosts,
      hasMore: posts.length === limit,
      page,
      limit
    });
  } catch (error) {
    logger.error('Error fetching posts', error);
    res.status(500).json({ message: 'Error fetching posts' });
  }
};

// Get post by ID
export const getPostById = async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    // This route is public (anonymous discovery). No id-shape guard: `posts.id`
    // is `text` holding an ObjectId hex for pre-cutover rows and a uuid v7 for
    // everything after, so a validity check would 404 every post created since
    // the cutover. An unknown id simply matches no row, which is the same 404.
    const postId = String(req.params.id);

    const post = await loadPostRecord(postId);

    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const hydrated = await postHydrationService.hydratePosts([post], {
      viewerId: currentUserId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 2,
      includeLinkMetadata: true,
      // Single-post detail read — the surface that renders the quote count.
      includeQuoteCounts: true,
    });

    const hydratedPost = hydrated[0];
    if (!hydratedPost) {
      return res.status(404).json({ message: 'Post not available' });
    }

    res.json(hydratedPost);
  } catch (error) {
    logger.error('Error fetching post', error);
    res.status(500).json({ message: 'Error fetching post' });
  }
};

/**
 * `GET /posts/:id/corrections` — a post's public correction trail.
 *
 * The trail is readable exactly when the POST is, and that is enforced by
 * hydrating the post for this viewer and 404ing when hydration drops it —
 * reusing the one ACL rather than restating it. A second implementation of "may
 * this viewer see this post" is a second answer, and the one that is wrong is
 * wrong in the direction of serving superseded bodies of a post the viewer was
 * refused.
 *
 * Public like `getPostById`, for the same reason: a publication's corrections
 * are addressed to whoever read the post, and most of them are not signed in.
 *
 * The response is served straight from the trail rather than from the summary on
 * the post, so `total` and the rows come from one read and cannot disagree about
 * a correction made between two of them.
 */
export const getPostCorrections = async (req: AuthRequest, res: Response) => {
  try {
    const postId = String(req.params.id);
    const post = await loadPostRecord(postId);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const hydrated = await postHydrationService.hydratePosts([post], {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
    });
    if (hydrated.length === 0) {
      return res.status(404).json({ message: 'Post not available' });
    }

    const corrections = await listPostCorrections(postId);
    const response: PostCorrectionsResponse = {
      postId,
      // The post's own counter, NOT `corrections.length`: retention drops
      // intermediate bodies, and a total taken from the surviving rows would
      // report a publication as having corrected itself fewer times than it did.
      total: post.correctionCount,
      corrections,
    };
    return res.json(response);
  } catch (error) {
    logger.error('Error fetching post corrections', { postId: String(req.params.id), error });
    return res.status(500).json({ message: 'Error fetching post corrections' });
  }
};

/**
 * The renditions a post carries after an edit.
 *
 * Three cases, and the machine translations survive NONE of them — they translate
 * a body that no longer exists:
 *  - the edit supplies an author variant set → it replaces the old one outright
 *    (the composer's language tabs are the whole truth);
 *  - the post is multilingual and only its body changed → the new body lands on the
 *    PRIMARY variant and the other declared languages are left exactly as the author
 *    wrote them (a Spanish edit must not silently rewrite the English rendition);
 *  - the post is single-language → the primary is rebuilt from the new body, re-tagged
 *    with what the classifier just detected, so an edit that changes the language of
 *    the post is actually allowed to change the language of the post.
 */
const rewriteEditedVariants = (params: {
  authorLanguageVariants?: PostContentVariant[];
  existingAuthorVariants: PostContentVariant[];
  text?: string;
  detectedPrimary?: string;
}): PostContentVariant[] => {
  const { authorLanguageVariants, existingAuthorVariants, text, detectedPrimary } = params;

  if (authorLanguageVariants !== undefined) {
    return authorLanguageVariants;
  }

  const newText = text ?? '';

  if (existingAuthorVariants.length > 1) {
    return existingAuthorVariants.map((variant, index) =>
      index === 0 ? { ...variant, text: newText } : variant,
    );
  }

  const primary = buildPrimaryVariant(newText, detectedPrimary);
  return primary ? [primary] : [];
};

// Update post
export const updatePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Fetched by id and authorized separately, rather than scoped by
    // `oxy_user_id = userId`. A CHANNEL post's `oxyUserId` is the channel — an
    // account nobody can be signed in as — so the scoped lookup made every
    // channel post uneditable by everybody, including the person who wrote it.
    // `postManagementRefusal` below is what decides, and it still answers 404,
    // so the reply is unchanged for a caller who may not touch this post.
    const loaded = await loadPostRecord(String(req.params.id));
    if (!loaded) {
      return res.status(404).json({ message: 'Post not found' });
    }
    const editRefusal = await postManagementRefusal({
      post: loaded,
      callerId: userId,
      memberReader: createUserScopedOxyServices(req),
    });
    if (editRefusal) {
      return res.status(editRefusal.status).json({ message: editRefusal.message });
    }

    // The 30-minute edit window exists because READERS have already seen a
    // published post: rewriting one indefinitely is a trust problem, so the
    // author gets a short grace period and no more.
    //
    // A SCHEDULED post has no readers. It has not published, has not federated,
    // and has emitted no MTN record — so the window's reason simply does not
    // apply, while the window itself would make a post scheduled for next
    // Tuesday uneditable thirty minutes after it was written. Hence the
    // carve-out. It is decided from the STORED status read in this request;
    // nothing the client sends can select it.
    // A CHANNEL post has no window either, and for the opposite reason to a
    // scheduled one: not that nobody has read it, but that a publication is
    // expected to fix what it published however long ago — and to do it in the
    // open. So the grace period is replaced rather than extended: the post stays
    // editable for life, and every change to its body appends a row to
    // `post_corrections` that says what it said before (see below). Permanent
    // editability WITHOUT that trail would be strictly worse than the window,
    // because it would let a publication rewrite what people read with nothing to
    // show for it.
    //
    // `isChannelAccount` fails SOFT to `false`, which here means "apply the
    // window" — during an Oxy identity outage a late correction is refused rather
    // than allowed, and refusing an edit is the recoverable direction.
    const editingScheduledPost = loaded.status === 'scheduled';
    const editingChannelPost = await isChannelAccount(loaded.oxyUserId);
    if (!editingScheduledPost && !editingChannelPost) {
      const EDIT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
      if (Date.now() - loaded.createdAt.getTime() > EDIT_WINDOW_MS) {
        return res.status(403).json({ message: 'Edit window has expired. Posts can only be edited within 30 minutes of creation.' });
      }
    }

    // The edit is assembled as PLAIN VALUES and written once at the end, rather
    // than mutated onto a live document and saved. `content` is a graph across
    // six child tables whose `position` columns are densely unique, so the only
    // correct write is `replacePostContent`'s transactional delete-then-insert —
    // there is no per-field `markModified` to reach for, and a half-applied edit
    // would leave a post with some of its renditions.
    const post = loaded;
    const content: StoredPostContent = { ...post.content };
    const patch: PostRecordPatch = {};

    // Rescheduling. Only a post that is still scheduled can be moved — sending a
    // time for a published post is a client bug, not a silent no-op. The new
    // time may be EARLIER or later; the only bound is that it is still ahead,
    // since the publisher sweeps for `scheduled_for <= now` and a past time would
    // mean "publish on the next tick" while reading as a schedule.
    let rescheduledTo: Date | null = null;
    if (req.body.scheduledFor !== undefined) {
      if (!editingScheduledPost) {
        return res.status(400).json({ message: 'Only a scheduled post can be rescheduled' });
      }
      const nextScheduledFor = new Date(req.body.scheduledFor);
      if (Number.isNaN(nextScheduledFor.getTime())) {
        return res.status(400).json({ message: 'scheduledFor must be a valid date' });
      }
      if (nextScheduledFor.getTime() <= Date.now()) {
        return res.status(400).json({ message: 'scheduledFor must be in the future' });
      }
      patch.scheduledFor = nextScheduledFor;
      rescheduledTo = nextScheduledFor;
    }

    // Support both flat body fields and nested content object from frontend
    const contentObj = req.body.content;
    const media = contentObj?.media ?? req.body.media;
    const { hashtags, mentions, contentLocation, postLocation, sources } = req.body;

    // The media set the variants localize: the incoming one when this edit
    // replaces it, otherwise the set already on the post.
    const normalizedMedia = media !== undefined ? normalizeMediaItems(media) : undefined;
    const sharedMediaIds = (normalizedMedia ?? content.media ?? []).map((item) => String(item.id));

    let authorLanguageVariants: PostContentVariant[] | undefined;
    if (contentObj?.variants !== undefined) {
      const variantResult = validateAuthorVariants(contentObj.variants, sharedMediaIds);
      if (!variantResult.ok) {
        return res.status(400).json({ message: variantResult.error });
      }
      authorLanguageVariants = variantResult.variants;
    }

    const existingAuthorVariants = authorVariants(content);
    const currentText = existingAuthorVariants[0]?.text;

    // The new primary body: the first author variant's when this edit supplies
    // variants, otherwise the plain text field (the API's single-language shape).
    const text = authorLanguageVariants !== undefined
      ? (authorLanguageVariants[0]?.text ?? '')
      : (contentObj?.text ?? req.body.text);

    if (text !== undefined && typeof text === 'string' && text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ message: `Post text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` });
    }

    const textChanged = text !== undefined && currentText !== text;

    // Save the old primary body to edit history before modifying
    let nextHashtags = post.hashtags;
    if (textChanged) {
      patch.editHistory = currentText
        ? [...post.editHistory, currentText]
        : [...post.editHistory];
      patch.isEdited = true;
      // Re-extract hashtags when the body changes
      nextHashtags = mergeHashtags(text || '', hashtags || post.hashtags);
      patch.hashtags = nextHashtags;
    }

    if (normalizedMedia !== undefined) {
      content.media = normalizedMedia;
    }

    if (authorLanguageVariants !== undefined || textChanged) {
      // Re-classify the post for its new content. The deterministic Stage-A
      // classifier is pure/synchronous, so it refreshes the canonical
      // `postClassification.topics` slug list (plus languages/region/scores/
      // sensitive) inline; stale Stage-B `topicRefs` from the old text are
      // cleared and `status` is reset to `pending` so the AI batch re-refines
      // this post on its next cycle (a no-op when the AI batch is disabled —
      // the refreshed Stage-A slugs remain the canonical list).
      //
      // Only a real DECLARATION is fed back in: the variant set this edit supplies,
      // or the one already on the post when it holds several languages (nothing but
      // a declaration produces more than one). A post with a single, DERIVED
      // rendition declares nothing, so detection re-runs on the new body — otherwise
      // a post rewritten from Spanish into English would stay pinned to `es`, since
      // the classifier trusts a declaration over the detector.
      const declaredVariants = authorLanguageVariants
        ?? (existingAuthorVariants.length > 1 ? existingAuthorVariants : []);

      const signals = baselineContentClassifier.classify({
        text: text ?? currentText,
        hashtags: nextHashtags,
        languages: toBaseLanguages(declaredVariants.map((variant) => variant.tag)),
        sensitive: post.federation?.sensitive ?? post.metadata.isSensitive,
        isFederated: post.federation != null,
      });
      // A fresh Stage-A baseline with status reset to `pending`, and the Stage-B
      // fields reset WITH it: `attempts` back to 0, the AI `scores`/`sentiment`/
      // `intent`/`confidence` replaced by the deterministic ones, `topicRefs`
      // cleared. Mongo got that for free by replacing the whole subdocument and
      // letting the schema defaults refill it; here every reset field is named,
      // because `updatePostRecord` MERGES a partial and would otherwise leave the
      // previous body's AI topics attached to the new one.
      patch.postClassification = {
        status: POST_CLASSIFICATION_PENDING,
        attempts: 0,
        topics: signals.topics,
        topicRefs: [],
        languages: signals.languages,
        region: signals.region,
        hashtagsNorm: signals.hashtagsNorm,
        trendTerms: signals.trendTerms,
        sensitive: signals.sensitive,
        scores: signals.scores,
        version: signals.version,
        sentiment: 'neutral',
        intent: 'other',
        confidence: 0,
        classifiedAt: new Date(signals.classifiedAt),
      };
      const primaryLanguage = signals.languages[0];
      if (primaryLanguage != null) {
        patch.language = primaryLanguage;
      }

      // Rewrite the renditions. Every branch drops the machine translations: they
      // translate a body that no longer exists, and serving one would show a reader
      // the post as it used to be.
      //
      // `stripSpamHashtagBlocks` is the edit half of the retired `pre('validate')`
      // hook (`toStoredContent` is the create half). It sits INSIDE this branch on
      // purpose: the branch condition — the edit supplied renditions, or the body
      // changed — is what `isModified('content.variants')` used to answer, so a
      // media-only or settings-only edit still rewrites nobody's words. The tags
      // themselves survive the strip: `patch.hashtags` was taken from the RAW body
      // above, before this runs.
      content.variants = stripSpamHashtagBlocks(rewriteEditedVariants({
        authorLanguageVariants,
        existingAuthorVariants,
        text,
        detectedPrimary: primaryLanguage,
      }));
    }

    // Handle content location updates (user's shared location)
    if (contentLocation !== undefined) {
      if (contentLocation === null) {
        // Remove content location
        content.location = undefined;
      } else if (contentLocation.latitude !== undefined && contentLocation.longitude !== undefined) {
        // Update content location
        content.location = {
          type: 'Point',
          coordinates: [contentLocation.longitude, contentLocation.latitude], // GeoJSON format: [lng, lat]
          address: contentLocation.address || undefined
        };
      }
    }

    // Handle post location updates (creation location metadata)
    if (postLocation !== undefined) {
      if (postLocation === null) {
        // Remove post location. `null` is the ERASURE, distinct from the
        // `undefined` that means "this edit does not mention the location" —
        // `updatePostRecord` reads the two differently and would keep the old
        // coordinates for `undefined`.
        patch.location = null;
      } else if (postLocation.latitude !== undefined && postLocation.longitude !== undefined) {
        // Update post location
        patch.location = {
          type: 'Point',
          coordinates: [postLocation.longitude, postLocation.latitude], // GeoJSON format: [lng, lat]
          address: postLocation.address || undefined
        };
      }
    }

    if (sources !== undefined) {
      const { sources: sanitized, error: sourcesErr } = sanitizeSources(sources);
      if (sourcesErr) {
        return res.status(400).json({ message: sourcesErr });
      }
      content.sources = sanitized.length ? sanitized : undefined;
    }

    if (req.body.article !== undefined) {
      const sanitizedArticle = sanitizeArticle(req.body.article);
      const existingArticleId = content.article?.articleId;
      if (sanitizedArticle) {
        const existing = existingArticleId ? await findArticleById(existingArticleId) : undefined;
        const previousArticle = content.article || {};

        // `updateArticle` re-anchors `post_id` as well as writing the body, so
        // the two branches differ only in whether a row already exists.
        let articleId: string;
        if (existing) {
          articleId = existing.id;
          await updateArticle(articleId, post.id, {
            title: sanitizedArticle.title,
            body: sanitizedArticle.body,
          });
        } else {
          articleId = newArticleId();
          await insertArticle({
            id: articleId,
            createdBy: userId,
            postId: post.id,
            title: sanitizedArticle.title || undefined,
            body: sanitizedArticle.body || undefined,
          });
        }
        content.article = {
          articleId,
          title: sanitizedArticle.title !== undefined ? sanitizedArticle.title : previousArticle.title,
          excerpt: sanitizedArticle.body !== undefined
            ? (sanitizedArticle.body ? sanitizedArticle.body.slice(0, 280) : undefined)
            : previousArticle.excerpt,
        };
      } else {
        if (existingArticleId) {
          await deleteArticles([existingArticleId]);
        }
        content.article = undefined;
      }
    }
    const attachmentUpdateInput = req.body.content?.attachments ?? req.body.attachments ?? req.body.attachmentOrder;
    const updatedAttachments = buildOrderedAttachments({
      rawAttachments: attachmentUpdateInput ?? content.attachments,
      media: Array.isArray(content.media) ? content.media : [],
      includePoll: Boolean(content.pollId),
      includeArticle: Boolean(content.article),
      includeEvent: Boolean(content.event),
      includeRoom: Boolean(content.room),
      includeLocation: Boolean(content.location),
      includeSources: Boolean(content.sources && content.sources.length),
      includePodcast: Boolean(content.podcast)
    });

    content.attachments = updatedAttachments ?? undefined;

    if (hashtags !== undefined) patch.hashtags = mergeHashtags('', hashtags || []);

    // An edit is a write boundary like any other: a profile link the author has
    // just pasted into the body becomes a mention here, on the same terms as on
    // creation (see `foldProfileLinkMentions`). Run after the renditions above
    // have been rewritten, so it reads the body this edit is actually storing.
    // `content` is the object this request will persist, and the fold rewrites it
    // in place — no `markModified` equivalent is needed, because the whole column
    // is written back below rather than a tracked subtree of a live document.
    const foldedMentions = await foldProfileLinkMentions(
      content,
      mentions !== undefined ? mentions : post.mentions,
    );
    const nextMentions = reconcileMentionIdsForPost(
      mentionTextsFromContent(content),
      foldedMentions.mentions,
    );

    const collaboratorIds = await postCollaborationService.resolveCollaboratorRefs(
      userId,
      Array.isArray(req.body.collaboratorIds) ? req.body.collaboratorIds : undefined,
      Array.isArray(req.body.collaboratorHandles) ? req.body.collaboratorHandles : undefined,
    );

    // An edit that started under the scheduled carve-out must not land on a post
    // that went live while it was being assembled — the publisher sweeps every
    // 60s, and the body above does its own I/O (article save, collaborator
    // resolution). Re-read the STORED status as late as possible and refuse
    // rather than write, so a just-published post cannot be edited without its
    // 30-minute window. This narrows the window to the gap between this read and
    // the two writes below; it does not close it, because the content graph is a
    // second statement that no predicate on the first could cover. The residual
    // exposure is bounded: `status` is not among the patched columns, so the
    // write can never revert a publish, and the federation/MTN gates below
    // re-read the status themselves.
    if (editingScheduledPost) {
      const [stillScheduled] = await getDb()
        .select({ id: postsTable.id })
        .from(postsTable)
        .where(and(eq(postsTable.id, post.id), eq(postsTable.status, 'scheduled')))
        .limit(1);
      if (!stillScheduled) {
        return res.status(409).json({
          message: 'This post published while you were editing it. Reload it to edit within the 30-minute window.',
        });
      }
    }

    await updatePostRecord(post.id, patch);
    await replacePostContent(post.id, content, nextMentions);

    // The correction trail — the half of permanent editability that makes it
    // honest. Recorded AFTER the write, so an edit that failed leaves no claim
    // that the post once said something else.
    //
    // Three conditions, and each excludes a case where there is nothing to be
    // accountable for. A channel post, because only a publication trades its
    // window for a trail. A change to the BODY, because that is what a reader
    // read — a lane move, a pin or a media swap is not a correction and
    // `isEdited` has never counted one either. And a post that was already
    // PUBLISHED before this edit: a draft or a scheduled post has no readers, so
    // rewriting it corrects nobody's understanding of anything.
    let correction: Awaited<ReturnType<typeof recordPostCorrection>> = null;
    if (editingChannelPost && textChanged && post.status === 'published') {
      correction = await recordPostCorrection({
        postId: post.id,
        previousText: currentText ?? '',
        correctedByOxyUserId: userId,
        correctedAt: new Date(),
      });
    }

    // A scheduled THREAD has one publish moment, not one per post: its
    // continuations are replies to each other and the author picked a time for
    // the thread, so moving any member moves the whole chain. Leaving the others
    // behind would not break the ordering invariant — a continuation whose
    // parent is still scheduled simply waits — but it would show the author a
    // queue with three different times for one thread and publish it in dribs.
    // After the write, so a failed edit cannot move anything.
    //
    // Scoped to the post's OWNER, never the caller. A channel's thread is owned
    // by the channel, so walking it as the caller matched nothing and moved the
    // edited post alone — silently producing the exact split queue this block
    // exists to prevent, with no error anywhere. The caller's right to be here at
    // all was settled by `postManagementRefusal` above; this only has to name the
    // account whose chain it is.
    if (rescheduledTo) {
      const chainOwnerId = post.oxyUserId ? String(post.oxyUserId) : userId;
      const chain = await loadScheduledChain(post.id, chainOwnerId);
      if (chain.ok) {
        const others = chain.postIds.filter((id) => id !== post.id);
        if (others.length > 0) {
          await getDb()
            .update(postsTable)
            .set({ scheduledFor: rescheduledTo })
            .where(and(
              inArray(postsTable.id, others),
              eq(postsTable.oxyUserId, chainOwnerId),
              eq(postsTable.status, 'scheduled'),
            ));
        }
      }
    }

    let edited: PostRecord = {
      ...post,
      ...(patch.isEdited !== undefined ? { isEdited: patch.isEdited } : {}),
      ...(patch.editHistory !== undefined ? { editHistory: patch.editHistory } : {}),
      ...(patch.hashtags !== undefined ? { hashtags: patch.hashtags } : {}),
      ...(patch.language ? { language: patch.language } : {}),
      ...(patch.postClassification !== undefined
        ? { postClassification: { ...post.postClassification, ...patch.postClassification } }
        : {}),
      ...(patch.location !== undefined ? { location: patch.location ?? undefined } : {}),
      // Carried onto the in-memory record so the response this request hydrates
      // already shows the correction it just made. Without it the marker appears
      // only on the NEXT read of the post.
      ...(correction
        ? { correctionCount: correction.correctionCount, lastCorrectedAt: correction.correctedAt }
        : {}),
      content,
      mentions: nextMentions,
    };

    if (collaboratorIds && collaboratorIds.length > 0) {
      edited = await postCollaborationService.attachCollaborators(edited, userId, collaboratorIds);
    }

    const isPublished = edited.status === 'published';
    if (isPublished && collaboratorIds && collaboratorIds.length > 0) {
      const autoAcceptIds = await resolveMcpAutoAcceptIds(req, collaboratorIds);
      if (autoAcceptIds && autoAcceptIds.length > 0) {
        edited = await postCollaborationService.autoAcceptInvites(edited, new Set(autoAcceptIds));
      }
      await postCollaborationService.notifyPendingInvites(edited, userId);
    }

    // MTN dual-write: an edit re-emits the `app.mention.feed.post` record under
    // the SAME rkey (the post id). The chain is append-only and materialization
    // is last-writer-wins by chain order, so the new record supersedes the old
    // version. Only LOCAL posts emit (an edited federated post never had a record;
    // the 30-minute edit window above only applies to owner-scoped native posts).
    if (edited.federation == null && edited.oxyUserId) {
      await emitPostCreated(edited);
    }

    // Outbound federation: an edit re-federates the Note as an ActivityPub
    // Update (carrying an `updated` timestamp — how Mastodon marks an edit),
    // reusing the shared Note builder so a reply's `inReplyTo` + parent Mention
    // survive. Local + published + public non-boost only; the same gates as
    // creation. Username resolved server-side from the authoritative oxyUserId.
    //
    // The whole DOCUMENT goes through the seam. The Note builder reads more than
    // `LocalPostEventPayload` names — `metadata.isSensitive` becomes the Note's
    // `sensitive` flag, `quoteOf` its quote fields — so a hand-picked field list
    // re-federated an edited sensitive post as UNMARKED and dropped the quote,
    // which is the shape `PostCreationService` has always avoided by passing the
    // document.
    if (
      edited.federation == null &&
      edited.oxyUserId &&
      !edited.boostOf &&
      edited.visibility === PostVisibility.PUBLIC &&
      edited.status === 'published'
    ) {
      const editorOxyUserId = edited.oxyUserId;
      federateAsResolvedActor(editorOxyUserId, 'post update', (username) => ({
        kind: 'post.update',
        post: toFederationPostPayload(edited),
        actorOxyUserId: editorOxyUserId,
        actorUsername: username,
      }));
    }

    // Hydrate the updated post for consistent frontend response shape.
    // PostHydrationService is the single source of truth for post DTOs; we do NOT
    // hand-build a `user` object here (that would leak the raw oxyUserId as the
    // display name and break the profile-identity contract). If hydration fails
    // for this just-saved, owner-scoped post, treat it as a server-side error.
    const hydrated = await postHydrationService.hydratePosts([edited], {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
    });
    if (hydrated.length === 0) {
      logger.error('Failed to hydrate edited post', { postId: edited.id, userId });
      return res.status(500).json({ message: 'Error updating post' });
    }
    res.json(hydrated[0]);
  } catch (error) {
    if (error instanceof CollabValidationError) {
      return res.status(400).json({ message: error.message });
    }
    if (error instanceof CollabStateError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('Error updating post', error);
    res.status(500).json({ message: 'Error updating post' });
  }
};

// Update post settings (pin, hide counts, reply permissions, review replies)
export const updatePostSettings = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // By id then authorized — see `updatePost` for why the owner-scoped lookup
    // could not serve a channel post.
    const post = await loadPostRecord(String(req.params.id));
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    const settingsRefusal = await postManagementRefusal({
      post,
      callerId: userId,
      memberReader: createUserScopedOxyServices(req),
    });
    if (settingsRefusal) {
      return res.status(settingsRefusal.status).json({ message: settingsRefusal.message });
    }

    const { isPinned, hideEngagementCounts, replyPermission, reviewReplies, quotesDisabled } = req.body;

    const patch: PostRecordPatch = {};
    const metadata: NonNullable<PostRecordPatch['metadata']> = {};

    if (isPinned !== undefined) {
      if (typeof isPinned !== 'boolean') {
        return res.status(400).json({ message: 'isPinned must be a boolean' });
      }
      metadata.isPinned = isPinned;
    }

    if (hideEngagementCounts !== undefined) {
      if (typeof hideEngagementCounts !== 'boolean') {
        return res.status(400).json({ message: 'hideEngagementCounts must be a boolean' });
      }
      metadata.hideEngagementCounts = hideEngagementCounts;
    }

    if (replyPermission !== undefined) {
      // A channel post's `replyPermission` is not the author's to change. The
      // server's refusal does not depend on this field (see
      // `utils/channelReplyGate`), so a change here could not actually reopen the
      // post — but it WOULD un-hide the client's reply button and leave every
      // reader hitting a 403 they were invited to attempt. The stored `['nobody']`
      // is defence in depth precisely because it is what the client reads, so it
      // has to stay put.
      if (await postIsAuthoredByChannel(post)) {
        return res.status(400).json({
          message: 'A post published by a channel does not accept replies',
        });
      }
      const validPermissions = ['anyone', 'followers', 'following', 'mentioned', 'nobody'];
      if (!Array.isArray(replyPermission) || replyPermission.length === 0) {
        return res.status(400).json({ message: 'replyPermission must be a non-empty array' });
      }
      const allValid = replyPermission.every((p: string) => validPermissions.includes(p));
      if (!allValid) {
        return res.status(400).json({ message: `replyPermission values must be one of: ${validPermissions.join(', ')}` });
      }
      patch.replyPermission = replyPermission as ReplyPermission[];
    }

    if (reviewReplies !== undefined) {
      if (typeof reviewReplies !== 'boolean') {
        return res.status(400).json({ message: 'reviewReplies must be a boolean' });
      }
      patch.reviewReplies = reviewReplies;
    }

    if (quotesDisabled !== undefined) {
      if (typeof quotesDisabled !== 'boolean') {
        return res.status(400).json({ message: 'quotesDisabled must be a boolean' });
      }
      patch.quotesDisabled = quotesDisabled;
    }

    if (Object.keys(metadata).length > 0) patch.metadata = metadata;
    await updatePostRecord(post.id, patch);

    res.json({
      message: 'Post settings updated',
      isPinned: metadata.isPinned ?? post.metadata.isPinned,
      hideEngagementCounts: metadata.hideEngagementCounts ?? post.metadata.hideEngagementCounts,
      replyPermission: patch.replyPermission ?? post.replyPermission,
      reviewReplies: patch.reviewReplies ?? post.reviewReplies,
      quotesDisabled: patch.quotesDisabled ?? post.quotesDisabled,
    });
  } catch (error) {
    logger.error('Error updating post settings', error);
    res.status(500).json({ message: 'Error updating post settings' });
  }
};

/**
 * PATCH /posts/:id/lane — move one of the author's own posts between their lanes,
 * or (with `laneId: null`) out of every lane.
 *
 * **There is deliberately NO edit window here, and nobody should add one by
 * copying the 30-minute guard out of `updatePost`.** That window exists because
 * REWRITING THE TEXT of a post people have already read is a trust problem.
 * Moving a post between the author's own organizational carriageways changes no
 * text: it does not federate, does not emit an MTN record, does not set
 * `isEdited`, and does not re-classify. Pinning/unpinning already has no window
 * for exactly the same reason, which is why this is modelled on
 * `updatePostSettings` rather than on `updatePost`.
 *
 * Owner-only, and scoped by `oxyUserId` in the query, so somebody else's post is
 * a 404 rather than a 403 that confirms it exists.
 *
 * **The success body uses `sendSuccessResponse`'s `{data}` envelope, unlike every
 * other handler in this file — that is deliberate, not an oversight.** This is a
 * Lanes endpoint that happens to live on the posts router because it addresses a
 * post; its only client is `lanesService`, which reads every OTHER lane endpoint
 * (all of `routes/lanes.routes.ts`) through that envelope. Matching the feature
 * the client sees beats matching the file the handler sits in. The error paths
 * deliberately stay on this file's bare `{message}` shape, which is what the rest
 * of the posts API — and this controller's own `LaneAssignmentError` mapping in
 * `createPost` — already returns.
 *
 * ---------------------------------------------------------------------------
 * NAMED EXCEPTION FOR THE NEXT MERGE FROM `main` — DO NOT AUTO-RESOLVE THIS ROUTE
 *
 * This branch re-ported Channels/Lanes against `main` at **`f54db41e`**, where a
 * channel post is not the caller's to move: the lookup below is scoped by
 * `oxy_user_id = userId`, so a post authored by the CHANNEL is a 404 here and the
 * writer cannot relane it.
 *
 * `main` has since moved to **`036927ed`**, which answers that question
 * DIFFERENTLY: it looks the post up by id alone and authorizes through a
 * `postManagementRefusal` helper — a symbol that **exists nowhere in this tree** —
 * letting the WRITER move a channel post, with the lane measured against the
 * channel rather than against the caller.
 *
 * **That is an authorization decision wearing a merge conflict's clothes.** Taking
 * either side mechanically ships a permission bug, and NO TEST ON THIS BRANCH
 * WOULD CATCH IT: this branch's tests encode the `f54db41e` semantics, so they go
 * green while being wrong about who may move what.
 *
 * So when the catch-up merge happens: read this route against main's new helper
 * as a deliberate decision, and REWRITE its tests to whichever semantics you
 * choose. Do not carry the ones below forward as evidence.
 * ---------------------------------------------------------------------------
 */
export const updatePostLane = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { laneId } = req.body;
    if (laneId !== null && typeof laneId !== 'string') {
      return res.status(400).json({ message: 'laneId must be a lane id or null' });
    }

    // By id, NOT narrowed by `oxy_user_id` — see `updatePost`. The projection
    // carries `oxy_user_id` and `written_by_oxy_user_id` because
    // `postManagementRefusal` reads both: the first names the account that
    // authored it (a channel, for a channel post) and the second the human who
    // wrote it, and a projection missing either silently refuses its own writer.
    const [post] = await getDb()
      .select({
        id: postsTable.id,
        parentPostId: postsTable.parentPostId,
        boostOf: postsTable.boostOf,
        laneId: postsTable.laneId,
        oxyUserId: postsTable.oxyUserId,
        writtenByOxyUserId: postsTable.writtenByOxyUserId,
      })
      .from(postsTable)
      .where(eq(postsTable.id, String(req.params.id)))
      .limit(1);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    const laneRefusal = await postManagementRefusal({
      post,
      callerId: userId,
      memberReader: createUserScopedOxyServices(req),
    });
    if (laneRefusal) {
      return res.status(laneRefusal.status).json({ message: laneRefusal.message });
    }

    // The SAME rule the create path applies, from the same definition: a lane
    // belongs to its publisher, and replies/boosts carry none.
    //
    // **The publisher is read off the POST, never taken as the caller.** It used
    // to be `userId`, which was safe only while the lookup above was narrowed by
    // `oxy_user_id = userId` — the two could not disagree. They can now, because
    // that narrowing is gone (a channel post's author is the channel, so it made
    // every channel post unmovable): a channel post is authored by the channel
    // and moved by a human, so passing the caller here would offer the WRITER's
    // own lanes for a post the channel published. A channel post landing in a
    // personal lane deanonymizes the writer, because a lane tab is scoped to one
    // author even though the post's DTO stays anonymous.
    await assertLaneAssignable({
      laneId,
      authorId: post.oxyUserId ? String(post.oxyUserId) : null,
      parentPostId: post.parentPostId,
      boostOf: post.boostOf,
    });

    // NULL, and here that is exactly right. Mongo needed `$unset` rather than a
    // stored null because `post_lane_chrono_v1`'s partial filter is
    // `{ laneId: { $exists: true } }`, which a null SATISFIES — leaving a
    // laneless post indexed forever. The Postgres partial index is
    // `where lane_id is not null`, so null is the state that removes the row
    // from it. "Absent" and "null" are one state here, so the trap does not
    // survive the port.
    //
    // Scoped by the post's AUTHOR, never the caller, for the same reason the
    // lane check above is. Left as `oxy_user_id = userId` this matched nothing
    // for a channel post — and an `UPDATE` that matches nothing is not an error,
    // so the handler answered 200 with the new lane's summary while the post had
    // not moved.
    await getDb()
      .update(postsTable)
      .set({ laneId: laneId ?? null })
      .where(and(eq(postsTable.id, post.id), eq(postsTable.oxyUserId, post.oxyUserId ?? '')));

    const [lane] = laneId
      ? await getDb()
        .select({ id: lanesTable.id, name: lanesTable.name, displayMode: lanesTable.displayMode })
        .from(lanesTable)
        .where(eq(lanesTable.id, laneId))
        .limit(1)
      : [];

    return sendSuccessResponse(
      res,
      200,
      {
        postId: post.id,
        lane: lane
          ? { id: lane.id, name: lane.name, displayMode: lane.displayMode }
          : null,
      },
      'Post lane updated',
    );
  } catch (error) {
    if (error instanceof LaneAssignmentError) {
      return res.status(error.status).json({ message: error.message });
    }
    logger.error('Error updating post lane', error);
    res.status(500).json({ message: 'Error updating post lane' });
  }
};

// Delete post
export const deletePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Cancelling a SCHEDULED post takes its scheduled continuations with it, and
    // the ids are collected BEFORE the delete, while the chain is still walkable.
    // A thread's continuations exist only as replies to their predecessor: once
    // the parent is gone they can never publish (the claim refuses a post whose
    // parent has not published) and nobody can see them either, so leaving them
    // behind would be a silent black hole in the author's queue rather than a
    // cancellation. Empty for a published post and for a lone scheduled one.
    // Resolved and authorized BEFORE anything is deleted or walked, because both
    // of the steps below need the post's AUTHOR — which for a channel post is
    // the channel, not the caller.
    // Two columns, not a whole `PostRecord`: this read exists only to answer
    // "may the caller manage this post", and assembling the content graph for it
    // would be six extra joins on the way to a decision that reads neither.
    const [target] = await getDb()
      .select({
        oxyUserId: postsTable.oxyUserId,
        writtenByOxyUserId: postsTable.writtenByOxyUserId,
      })
      .from(postsTable)
      .where(eq(postsTable.id, String(req.params.id)))
      .limit(1);
    if (!target) {
      return res.status(404).json({ message: 'Post not found' });
    }
    const deleteRefusal = await postManagementRefusal({
      post: target,
      callerId: userId,
      memberReader: createUserScopedOxyServices(req),
    });
    if (deleteRefusal) {
      return res.status(deleteRefusal.status).json({ message: deleteRefusal.message });
    }
    const authorId = target.oxyUserId ? String(target.oxyUserId) : userId;

    const cancelledContinuations = await scheduledContinuationIds(String(req.params.id), authorId);

    /**
     * ONE TRANSACTION OWNS THE WHOLE SUBTREE, and the ORDER inside it is the
     * fix for a defect that shipped, not a stylistic preference.
     *
     * `posts.parent_post_id` is `ON DELETE SET NULL` and `posts.boost_of` is
     * `ON DELETE CASCADE`, so the instant the post row goes:
     *
     *   - its direct replies stop being findable and are silently PROMOTED to
     *     root posts (measured: the reply survives with `parent_post_id: null`
     *     and `is_reply: true`), and
     *   - every boost of it is removed by the database, taking the only link
     *     that could have found the boosts' own polymorphic references.
     *
     * So the capture comes FIRST, then the reference legs, then the replies,
     * then the post. Deleting first and repairing after — which is what this
     * route did — cannot work, and did not.
     *
     * The reference legs THROW, and that is only coherent because they are in
     * here with the `DELETE`: a leg that fails rolls the whole thing back, the
     * post is NOT deleted, and the 500 is honest and retryable. Outside a
     * transaction the same throw would report a completed deletion whose
     * leftovers no retry could ever reach.
     *
     * The OWNERSHIP CLAIM keeps its atomic-claim property. `deletePostRecord`
     * carries the `oxy_user_id` predicate in the DELETE's own `WHERE`, so it is
     * still one statement that authorizes and removes — not a read-then-write.
     * Two concurrent requests cannot both claim the row; the loser deletes
     * nothing, the whole transaction rolls back, and it answers 404 exactly as
     * before. Moving it inside a transaction changes when it commits, never
     * what it checks.
     */
    let deletion: DeletedPostSubtree | null = null;
    try {
      // `authorId`, NOT `userId`. Authorization was already decided above by
      // `postManagementRefusal`, which deliberately admits a channel post's
      // WRITER and its co-operators — none of whom is the row's `oxy_user_id`,
      // because a channel post is owned by the CHANNEL and no session can ever
      // have a channel as its subject. Claiming on the caller's own id therefore
      // matched nothing and answered 404 to the person who wrote the post, after
      // telling them they were allowed. Same trap the lane path names two hundred
      // lines above; this is the site where it survived the port.
      //
      // The claim keeps its atomic-claim property: `authorId` comes from the row
      // this request already read and re-checks the SAME ownership the refusal
      // decided against, in the DELETE's own `WHERE`.
      deletion = await deletePostSubtree(
        String(req.params.id),
        eq(postsTable.oxyUserId, authorId),
      );
    } catch (error) {
      if (error instanceof PostDeletionTooLargeError) {
        logger.error('Post deletion refused: too many dependent rows', {
          postId: String(req.params.id),
          found: error.found,
        });
        return res.status(409).json({ message: 'Post has too many dependent rows to delete' });
      }
      throw error;
    }
    if (!deletion) {
      // Either no such post, or the ownership claim matched nothing — the
      // second rolled back, so nothing was removed for a caller who was never
      // allowed to. Both answer 404; distinguishing them would disclose that
      // the post exists.
      return res.status(404).json({ message: 'Post not found' });
    }
    const deletedPost: PostRecord = deletion.post;
    const deletedTargets: PostDeletionTargets = deletion.targets;
    const postId = deletedPost.id;

    // Everything from here is BEST-EFFORT: the deletion is committed and the
    // user is about to be told it succeeded, so a failure below must not turn
    // it into a 500. Each one is swallowed and COUNTED — fail-soft is fine,
    // silent is not.
    try {
      await repairRecentRepliersAfterPostDelete({
        postId,
        parentPostId: deletedPost.parentPostId,
      });
    } catch (error) {
      recordDeletionSideEffectFailure('recent_replier_projection', error);
    }
    try {
      await repairSurvivingCounters(deletedTargets, deletion.removedIds);
    } catch (error) {
      recordDeletionSideEffectFailure('surviving_counters', error);
    }

    // MTN dual-write: deleting a LOCAL post tombstones its
    // `app.mention.feed.post` record. (Federated posts never emitted a record.)
    if (deletedPost.federation == null && deletedPost.oxyUserId) {
      await emitTombstone({
        authorOxyUserId: deletedPost.oxyUserId,
        tombstoneRkey: postId,
        subjectUri: postRecordUri(deletedPost.oxyUserId, postId),
      });
    }

    // Outbound federation: broadcast a Delete(Tombstone) so remote followers'
    // Mastodon removes the post. The row is already gone, but its data (id +
    // author) is captured above from the deleted doc; the canonical Note id is
    // minted from the resolved username + post id. Local + published + public
    // only — an unpublished/private post was never federated. Username resolved
    // server-side from the authoritative oxyUserId.
    if (
      deletedPost.federation == null &&
      deletedPost.oxyUserId &&
      deletedPost.visibility === PostVisibility.PUBLIC &&
      deletedPost.status === 'published'
    ) {
      const deleterOxyUserId = deletedPost.oxyUserId;
      federateAsResolvedActor(deleterOxyUserId, 'post delete', (username) => ({
        kind: 'post.delete',
        post: { _id: postId },
        actorOxyUserId: deleterOxyUserId,
        actorUsername: username,
      }));
    }

    // The cascade ITSELF already ran, inside the transaction above — every
    // reference the delete claims is gone by the time the row is. What is left
    // here is the VERIFICATION: re-run exactly the claimed probes against the
    // committed state and say what is actually still there, rather than
    // assuming the legs worked.
    //
    // It has to be outside the transaction to mean anything. Inside, the probes
    // would read that transaction's own uncommitted deletes and pass by
    // construction — a check that cannot fail.
    try {
      await reportResidue(allDeletionTargets(deletedTargets), postId);
    } catch (error) {
      recordDeletionSideEffectFailure('residue_check', error);
    }

    await deleteScheduledContinuations(cancelledContinuations, userId);

    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    logger.error('Error deleting post', error);
    res.status(500).json({ message: 'Error deleting post' });
  }
};

/**
 * The scheduled posts that would be orphaned by cancelling `postId` — its own
 * scheduled descendants, never `postId` itself.
 *
 * Returns nothing unless `postId` is itself a scheduled post of `ownerId`:
 * deleting a PUBLISHED post leaves its replies standing (they are real posts
 * people have seen), and only an unpublished chain is the author's to withdraw.
 */
async function scheduledContinuationIds(postId: string, ownerId: string): Promise<string[]> {
  const [target] = await getDb()
    .select({ id: postsTable.id })
    .from(postsTable)
    .where(and(
      eq(postsTable.id, postId),
      eq(postsTable.oxyUserId, ownerId),
      eq(postsTable.status, 'scheduled'),
    ))
    .limit(1);
  if (!target) {
    return [];
  }
  const chain = await loadScheduledChain(postId, ownerId);
  if (!chain.ok) {
    return [];
  }
  // The chain walks up to its root as well; only what publishes AFTER this post
  // depends on it.
  const index = chain.postIds.indexOf(postId);
  return index === -1 ? [] : chain.postIds.slice(index + 1);
}

/**
 * Delete cancelled continuations and the only two records a never-published post
 * can own: its article and its poll.
 *
 * Everything else `deletePost` cleans up needs a reader — likes, bookmarks,
 * subscriptions, mention notifications — and a scheduled post has none by
 * construction (it never federated, emitted no MTN record, and `createThread`
 * withholds its mention notifications until publish). Best-effort: a
 * cancellation that removed the posts has done the part the author asked for.
 */
async function deleteScheduledContinuations(postIds: string[], ownerId: string): Promise<void> {
  if (postIds.length === 0) return;
  try {
    const cancelled = await findPostRecords(
      and(
        inArray(postsTable.id, postIds),
        eq(postsTable.oxyUserId, ownerId),
        eq(postsTable.status, 'scheduled'),
      ),
      { orderBy: CHRONO_DESC },
    );
    // No `articleIds` or `pollIds` here: both tables cascade from `posts` (see
    // deletePost). The `Article.deleteMany` that used to follow this loop was
    // reaching a store the article write path no longer uses.

    // Per-row, because `deletePostRecord` owns the child-table cascade a post's
    // nine tables need; a bare `DELETE … WHERE id = any(...)` would leave the
    // repository's own invariants to the database's foreign keys alone.
    await Promise.allSettled(
      cancelled.map((p) => deletePostRecord(p.id, eq(postsTable.oxyUserId, ownerId))),
    );
  } catch (error) {
    logger.error('Error cancelling scheduled thread continuations', error);
  }
}

/**
 * Apply an idempotent vote command. The relationship, counters and durable
 * outbox event commit in one transaction; MTN, notifications and federation
 * are delivered asynchronously from that event.
 */
export const likePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id as string;
    const value: 1 | -1 = req.body?.value === -1 ? -1 : 1;
    const surface = readInteractionSurface(req.body);

    logger.debug('Vote request received', {
      value,
      surface,
    });
    const result = await votePostCommand({ userId, postId, value, source: surface });

    if (result.changed && result.likeId && value === 1) {
      const postOwnerId = result.post.oxyUserId;
      if (postOwnerId) {
        void affinityEventService
          .record({
            fromUserId: userId,
            toUserId: postOwnerId,
            type: 'like',
            eventId: `like:${result.likeId}`,
          })
          .catch(() => undefined);
      }
    }

    // Learn only from a newly committed upvote. Idempotent retries and
    // downvotes must not inflate the viewer's positive preference signal.
    if (result.changed && value === 1) {
      void userPreferenceService
        .recordInteraction(userId, postId, 'like', { surface })
        .catch((error) => logger.warn('Failed to record interaction for preferences', error));
    }

    // Everyone watching this post gets the counters the transaction just wrote.
    // The two event names cover the whole vote axis: casting an upvote RAISES the
    // like count (from nothing, or by switching off a downvote), while a downvote
    // can only leave it where it was or lower it. Both counters ride along either
    // way, so a switched vote converges on one event. An unchanged vote moved
    // nothing and is not announced.
    if (result.changed) {
      emitPostEngagement({
        event: value === 1 ? POST_ENGAGEMENT_EVENTS.LIKED : POST_ENGAGEMENT_EVENTS.UNLIKED,
        postId,
        ...(result.post.oxyUserId ? { authorOxyUserId: result.post.oxyUserId } : {}),
        counts: {
          likes: result.post.statsLikesCount,
          downvotes: result.post.statsDownvotesCount,
        },
        actorId: userId,
      });
    }

    res.json({
      message: result.changed
        ? result.previousValue === null
          ? value === 1 ? 'Post liked successfully' : 'Post downvoted successfully'
          : 'Vote switched successfully'
        : 'Vote unchanged',
      likesCount: result.post.statsLikesCount,
      downvotesCount: result.post.statsDownvotesCount,
      liked: value === 1,
      downvoted: value === -1
    });
  } catch (error) {
    if (error instanceof EngagementPostNotFoundError) {
      return res.status(404).json({ message: 'Post not found' });
    }
    logger.error('Error voting on post', error);
    res.status(500).json({ message: 'Error voting on post' });
  }
};

// Remove vote (unlike or remove downvote)
export const unlikePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id as string;
    const result = await removeVoteCommand({ userId, postId });

    if (result.changed) {
      emitPostEngagement({
        event: POST_ENGAGEMENT_EVENTS.UNLIKED,
        postId,
        ...(result.post.oxyUserId ? { authorOxyUserId: result.post.oxyUserId } : {}),
        counts: {
          likes: result.post.statsLikesCount,
          downvotes: result.post.statsDownvotesCount,
        },
        actorId: userId,
      });
    }

    res.json({
      message: result.changed ? 'Vote removed successfully' : 'No vote to remove',
      likesCount: result.post.statsLikesCount,
      downvotesCount: result.post.statsDownvotesCount,
      liked: false,
      downvoted: false
    });
  } catch (error) {
    if (error instanceof EngagementPostNotFoundError) {
      return res.status(404).json({ message: 'Post not found' });
    }
    logger.error('Error removing vote', error);
    res.status(500).json({ message: 'Error removing vote' });
  }
};

// Save post
export const savePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id as string;
    const surface = readInteractionSurface(req.body);

    logger.debug('Save request received', { surface });
    const result = await savePostCommand({ userId, postId });

    // Learn only from the relationship transition, not an idempotent retry.
    if (result.changed) {
      void userPreferenceService
        .recordInteraction(userId, postId, 'save', { surface })
        .catch((error) => logger.warn('Failed to record interaction for preferences', error));
    }

    // No `actorId`: the save COUNT is public (it is on every post DTO), but who
    // saved a post is not, and a room is the wrong place to say it. The trade is
    // that this viewer's own other devices cannot tell their own save from a
    // stranger's — they do not need to, since only the count travels here.
    if (result.changed) {
      emitPostEngagement({
        event: POST_ENGAGEMENT_EVENTS.SAVED,
        postId,
        ...(result.post.oxyUserId ? { authorOxyUserId: result.post.oxyUserId } : {}),
        counts: { saves: result.post.statsSavesCount },
      });
    }

    res.json({
      message: result.changed ? 'Post saved successfully' : 'Post already saved',
      savesCount: result.post.statsSavesCount,
    });
  } catch (error) {
    if (error instanceof EngagementPostNotFoundError) {
      return res.status(404).json({ message: 'Post not found' });
    }
    logger.error('Error saving post', error);
    res.status(500).json({ message: 'Error saving post' });
  }
};

// Unsave post
export const unsavePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id as string;
    const result = await unsavePostCommand({ userId, postId });

    if (result.changed) {
      emitPostEngagement({
        event: POST_ENGAGEMENT_EVENTS.UNSAVED,
        postId,
        ...(result.post.oxyUserId ? { authorOxyUserId: result.post.oxyUserId } : {}),
        counts: { saves: result.post.statsSavesCount },
      });
    }

    // Durable MTN side effects are delivered by the transactional outbox.
    res.json({
      message: result.changed ? 'Post unsaved successfully' : 'Post not saved',
      savesCount: result.post.statsSavesCount,
    });
  } catch (error) {
    if (error instanceof EngagementPostNotFoundError) {
      return res.status(404).json({ message: 'Post not found' });
    }
    logger.error('Error unsaving post', error);
    res.status(500).json({ message: 'Error unsaving post' });
  }
};

// Get saved posts for current user
export const getSavedPosts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const page = queryInt(req.query.page) || 1;
    const limit = Math.min(queryInt(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const searchQuery = queryString(req.query.search);

    const folderFilter = queryString(req.query.folder);

    // Get saved post IDs for the user, optionally filtered by folder
    const savedPosts = await getDb()
      .select({ postId: bookmarksTable.postId })
      .from(bookmarksTable)
      .where(
        folderFilter
          ? and(eq(bookmarksTable.userId, userId), eq(bookmarksTable.folder, folderFilter))
          : eq(bookmarksTable.userId, userId),
      )
      .orderBy(desc(bookmarksTable.createdAt));

    const postIds = savedPosts.map((saved) => saved.postId);

    // Build query for posts
    // Don't filter by visibility - users should be able to see their saved posts regardless of visibility
    const conditions: SQL[] = [inArray(postsTable.id, postIds)];

    // Add search filter if provided
    if (searchQuery && searchQuery.trim()) {
      const trimmedQuery = searchQuery.trim();
      logger.debug('Applying saved-post search filter', {
        queryLength: trimmedQuery.length,
      });
      // Case-insensitive substring match over the renditions, which is where the
      // bodies live — so a saved post matches by ANY language the author wrote it
      // in. `ILIKE` with the term escaped for its own wildcards (`%`, `_`,
      // backslash), which is the direct analogue of Mongo's escaped `$regex`:
      // without it a saved search for `100%` would match every saved post.
      const escaped = trimmedQuery.replace(/[\\%_]/g, (char) => `\\${char}`);
      conditions.push(
        exists(
          getDb()
            .select({ one: sql`1` })
            .from(postContentVariants)
            .where(
              and(
                eq(postContentVariants.postId, postsTable.id),
                ilike(postContentVariants.body, `%${escaped}%`),
              ),
            ),
        ),
      );
      logger.debug('Built saved-post query', {
        savedPostCount: postIds.length,
        hasSearchFilter: true,
      });
    }

    // Get the actual posts
    const posts = postIds.length === 0
      ? []
      : await findPostRecords(and(...conditions), {
        orderBy: CHRONO_DESC,
        limit,
        offset: (page - 1) * limit,
      });

    const hydratedPosts = await postHydrationService.hydratePosts(posts, {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    res.json({
      posts: hydratedPosts,
      hasMore: posts.length === limit,
      page,
      limit
    });
  } catch (error) {
    logger.error('Error fetching saved posts', error);
    res.status(500).json({ message: 'Error fetching saved posts' });
  }
};

// Get bookmark folders for current user
export const getBookmarkFolders = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // `is not null`, never `<> null`: Mongo's `$ne: null` also excluded a MISSING
    // field, while SQL's `<>` against NULL evaluates to NULL and matches nothing,
    // so the literal translation returns an empty folder list for everyone.
    const rows = await getDb()
      .selectDistinct({ folder: bookmarksTable.folder })
      .from(bookmarksTable)
      .where(and(eq(bookmarksTable.userId, userId), isNotNull(bookmarksTable.folder)));
    res.json({ folders: rows.map((row) => row.folder) });
  } catch (error) {
    logger.error('Error fetching bookmark folders', error);
    res.status(500).json({ message: 'Error fetching bookmark folders' });
  }
};

const moveBookmarkFolder = async (
  req: AuthRequest,
  res: Response,
  target: BookmarkFolderTarget,
) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const bookmark = await updateBookmarkFolderForViewer({
      viewerId: userId,
      target,
      folder: req.body?.folder,
    });

    if (!bookmark) {
      return res.status(404).json({ message: 'Bookmark not found' });
    }

    return res.json({ bookmark });
  } catch (error) {
    if (error instanceof BookmarkFolderInputError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('Error moving bookmark to folder', error);
    return res.status(500).json({ message: 'Error moving bookmark to folder' });
  }
};

/**
 * Compatibility route for clients that already hold the Bookmark document id.
 */
export const moveBookmarkToFolder = async (req: AuthRequest, res: Response) =>
  moveBookmarkFolder(req, res, {
    kind: 'bookmarkId',
    id: String(req.params.id ?? ''),
  });

/**
 * Preferred app contract: saved-post DTOs expose the post id, not the private
 * Bookmark document id, so update the viewer's relation by `{ userId, postId }`.
 */
export const moveBookmarkToFolderByPostId = async (
  req: AuthRequest,
  res: Response,
) =>
  moveBookmarkFolder(req, res, {
    kind: 'postId',
    id: String(req.params.postId ?? ''),
  });

/**
 * The hashtag discovery predicate.
 *
 * Exported (with {@link buildPostsByTopicFilter}) so the visibility scope can be
 * asserted without booting the controller's server import chain. Both return a
 * predicate only — the cursor is applied by the handler, because the chronological
 * keyset needs an `await` (a legacy cursor carrying no timestamp is resolved by
 * one primary-key lookup) and a pure builder cannot make it.
 */
export function buildPostsByHashtagFilter(hashtag: string): SQL {
  return and(
    // `@>` on the `text[]`, GIN-indexed — the analogue of Mongo matching a
    // multikey array by element equality.
    arrayContains(postsTable.hashtags, [hashtag.toLowerCase()]),
    eq(postsTable.status, 'published'),
    eq(postsTable.visibility, 'public'),
  ) as SQL;
}

export const getPostsByHashtag = async (req: AuthRequest, res: Response) => {
  try {
    const hashtag = String(req.params.hashtag);
    const cursor = queryString(req.query.cursor);
    const limit = Math.min(queryInt(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const keyset = await chronoCursorSql(cursor);
    const posts = await findPostRecords(
      keyset ? and(buildPostsByHashtagFilter(hashtag), keyset) : buildPostsByHashtagFilter(hashtag),
      { orderBy: chronoOrderBy(), limit: limit + 1 },
    );

    const hasMore = posts.length > limit;
    const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
    const anchor = hasMore ? postsToReturn[postsToReturn.length - 1] : undefined;
    const nextCursor = anchor ? ChronoCursor.build(anchor.id, anchor.createdAt) : undefined;

    const hydratedPosts = await postHydrationService.hydratePosts(postsToReturn, {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    res.json({
      items: hydratedPosts,
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logger.error('Error fetching posts by hashtag', error);
    res.status(500).json({ message: 'Error fetching posts by hashtag' });
  }
};

/**
 * Build the topic-page query filter. Matches a published post whose canonical
 * registry-linked `postClassification.topicRefs.name` OR slug-only
 * `postClassification.topics` equals the normalized (lowercased) topic — the two
 * forms of the one canonical topic list (Stage-B AI refs and the Stage-A
 * rule-based slug baseline). Topic discovery is a public surface, so the
 * filter is constrained to public posts. Topics are stored lowercase, so the
 * lookup is lowercased for index efficiency. Exported for unit testing the canonical `$or`
 * contract without booting the controller's server import chain.
 */
export function buildPostsByTopicFilter(topicName: string): SQL {
  return and(
    topicSlugSql(topicName),
    eq(postsTable.status, 'published'),
    eq(postsTable.visibility, 'public'),
  ) as SQL;
}

// Get posts by classified topic or entity name
export const getPostsByTopic = async (req: AuthRequest, res: Response) => {
  try {
    const topicName = String(req.params.topic);
    const cursor = queryString(req.query.cursor);
    const limit = Math.min(queryInt(req.query.limit) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const keyset = await chronoCursorSql(cursor);
    const posts = await findPostRecords(
      keyset ? and(buildPostsByTopicFilter(topicName), keyset) : buildPostsByTopicFilter(topicName),
      { orderBy: chronoOrderBy(), limit: limit + 1 },
    );

    const hasMore = posts.length > limit;
    const postsToReturn = hasMore ? posts.slice(0, limit) : posts;
    const anchor = hasMore ? postsToReturn[postsToReturn.length - 1] : undefined;
    const nextCursor = anchor ? ChronoCursor.build(anchor.id, anchor.createdAt) : undefined;

    const hydratedPosts = await postHydrationService.hydratePosts(postsToReturn, {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    res.json({
      posts: hydratedPosts,
      topic: topicName,
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logger.error('Error fetching posts by topic', error);
    res.status(500).json({ message: 'Error fetching posts by topic' });
  }
};

// Get drafts
export const getDrafts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Sorted on `created_at`, which is what the Mongoose call MEANT: it passed
    // the snake_case column name, which Mongo treats as an absent field and
    // therefore as no sort at all. The column exists here, so the intended order
    // is finally the one served.
    const drafts = await findPostRecords(
      and(eq(postsTable.oxyUserId, userId), eq(postsTable.status, 'draft')),
      { orderBy: CHRONO_DESC },
    );

    res.json(drafts);
  } catch (error) {
    logger.error('Error fetching drafts', error);
    res.status(500).json({ message: 'Error fetching drafts' });
  }
};

/**
 * Publish one of the caller's scheduled posts immediately.
 *
 * Publishing early is NOT a reschedule to now — that would leave the post to the
 * next 60s sweep — and it is not a status flip either, because a scheduled post
 * has not federated, has not emitted its MTN record and has notified nobody, all
 * of which `PostCreationService.publishScheduledPost` does. So this reaches that
 * exact method rather than reimplementing publishing in a controller; the post
 * takes the identical pipeline, only sooner.
 *
 * The publish decision stays inside ONE atomic claim: the update filters on the
 * post's OWNER and `status: 'scheduled'`, so nothing can publish twice — not even
 * the sweep running concurrently, which selects on the same filter.
 *
 * **The owner is the post's `oxyUserId`, which is NOT the caller.** For a channel
 * post it is the channel — an account nobody can be signed in as — so passing the
 * caller here (as this did) made every channel's scheduled post unpublishable by
 * everybody, the writer included, while `DELETE /posts/:id` had already been
 * widened to let any member CANCEL that same post. Authorization is therefore
 * asked SEPARATELY, of `postManagementRefusal` — the one authority the other six
 * management routes use — and the owner it resolves is what scopes the claim. The
 * claim is no weaker for it: it still names one exact account, just the right one.
 *
 * **Publishing one post of a scheduled THREAD publishes the thread.** Its posts
 * are replies to one another, so there is no coherent way to send just one:
 * ahead of its parent is a reply to something nobody can see, and behind its
 * continuations is a thread that stops mid-sentence until its original time
 * comes round. The chain is the unit, and it goes out in order, root first.
 */
export const publishScheduledPostNow = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const targetId = String(req.params.id);

    // Two columns, not a whole `PostRecord`: this read only has to answer "may
    // the caller manage this post, and whose queue is it in". Assembling the
    // content graph for that would be nine joins on the way to a decision that
    // reads neither. Same shape, and the same order, as `deletePost`.
    const [target] = await getDb()
      .select({
        oxyUserId: postsTable.oxyUserId,
        writtenByOxyUserId: postsTable.writtenByOxyUserId,
      })
      .from(postsTable)
      .where(eq(postsTable.id, targetId))
      .limit(1);
    if (!target) {
      return res.status(404).json({ message: 'Post not found' });
    }
    const publishRefusal = await postManagementRefusal({
      post: target,
      callerId: userId,
      memberReader: createUserScopedOxyServices(req),
      // Publishing is irreversible and acts under the author's identity. A
      // stored writer may have left the channel since scheduling, so unlike
      // ordinary management actions this must prove their authority now.
      requireAuthorAuthority: true,
    });
    if (publishRefusal) {
      return res.status(publishRefusal.status).json({ message: publishRefusal.message });
    }
    // The account the chain and the claim are scoped to. Falls back to the caller
    // only for a post with no owner at all, which is a federated row — one that
    // `postManagementRefusal` has already refused above, so this is a total
    // function rather than a reachable branch.
    const ownerId = target.oxyUserId ? String(target.oxyUserId) : userId;

    const chain = await loadScheduledChain(targetId, ownerId);
    if (!chain.ok) {
      return res.status(409).json({
        message: 'This post continues a thread that has not been published yet.',
      });
    }

    // Root first, and stop at the first post that does not go out — the same
    // rule the sweep follows, for the same reason. A post left behind stays
    // scheduled and publishes at its own time, still in order.
    let published: PostRecord | null = null;
    for (const postId of chain.postIds) {
      const result = await postCreationService.claimAndPublishScheduledPost({ postId, ownerId });
      if (postId === targetId) {
        published = result;
      }
      if (result === null) {
        break;
      }
    }

    if (!published) {
      // The claim missed. Tell the caller why — a post that already went out is a
      // different situation from one that never existed — which is safe to
      // distinguish here because `postManagementRefusal` above has already
      // established they may manage this post. Scoped to the resolved OWNER, so
      // it still reports on the row the claim actually tried.
      const [own] = await getDb()
        .select({ status: postsTable.status })
        .from(postsTable)
        .where(and(
          eq(postsTable.id, targetId),
          eq(postsTable.oxyUserId, ownerId),
        ))
        .limit(1);
      if (own && own.status === 'published') {
        return res.status(409).json({ message: 'This post has already been published' });
      }
      return res.status(404).json({ message: 'Post not found' });
    }

    const hydratedPosts = await postHydrationService.hydratePosts([published], {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });
    if (hydratedPosts.length === 0) {
      logger.error('Failed to hydrate a just-published scheduled post', {
        postId: published.id,
        userId,
      });
      return res.status(500).json({ message: 'Error publishing scheduled post' });
    }

    res.json(hydratedPosts[0]);
  } catch (error) {
    logger.error('Error publishing scheduled post', error);
    res.status(500).json({ message: 'Error publishing scheduled post' });
  }
};

/**
 * The pending scheduled posts this caller can act on, soonest first: their own,
 * plus the SHARED EDITORIAL QUEUE of every channel they operate.
 *
 * ## Why the channel half exists
 *
 * Several people publish under one channel's byline, and scheduling was private
 * to each author — so two writers could schedule a story for the same Tuesday and
 * neither would know. Worse, and measured rather than inferred: a channel AUTHORS
 * its own posts, so a scheduled channel post carries the CHANNEL as `oxy_user_id`
 * — an account nobody can sign in as — and the owner-scoped query below returned
 * it to NOBODY, *including the person who scheduled it*. It could only ever leave
 * the queue via the 60-second sweep.
 *
 * ## Whose queue an entry belongs to is already in the DTO
 *
 * Each post's `user` IS its authoring account, so the client groups by
 * `post.user.id` with no extra field, no second request and no parallel notion of
 * "queue" to keep in sync with the posts themselves.
 *
 * ## Access control, still enforced twice and now agreeing
 *
 * The query admits an account only after {@link listOperatedChannelIds} confirms
 * an ACTIVE membership through the caller's OWN bearer, and hydration — the
 * single ACL authority — is told the same set, so a post reaches the response
 * only if BOTH agree. The two gates are fed from one resolution, so they cannot
 * drift; loosening the query alone would still return nothing.
 *
 * Fail-soft to `[]` (that resolver's own contract), so an Oxy outage degrades
 * this to the personal queue it has always been rather than 500-ing the
 * composer. It can never ADD an account, which is the direction that would
 * matter.
 *
 * ## Seeing and acting are the SAME right here, deliberately
 *
 * Membership is the strongest right that exists over a channel — it can never be
 * acted as — so there is nothing stronger to demand of someone publishing an
 * entry early than of someone reading it. `postManagementRefusal` already lets
 * any active member DELETE and EDIT these exact posts, so this restores
 * `affordance ⊆ permission` rather than stretching it: the read had been the
 * narrow half, not the wide one.
 *
 * ## WHO QUEUED IT is `signPosts`' decision, and is not made here
 *
 * These are hydrated by the same `PostHydrationService` as every other listing,
 * so an entry names its writer in `authors[]` exactly when the channel signs its
 * posts, and `writtenByOxyUserId` never crosses the wire either way. This surface
 * therefore makes NO new disclosure: it shows a member precisely what the
 * published post would have shown them.
 */
export const getScheduledPosts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // ONE resolution feeding both gates below. Asked with the caller's own client
    // because `GET /accounts` is anchored on the authenticated operator — a
    // service credential cannot ask "which accounts does person X operate" at all.
    const operatedChannelIds = await listOperatedChannelIds(createUserScopedOxyServices(req));

    const scheduledPosts = await findPostRecords(
      and(
        inArray(postsTable.oxyUserId, [userId, ...operatedChannelIds]),
        eq(postsTable.status, 'scheduled'),
      ),
      { orderBy: [asc(postsTable.scheduledFor), asc(postsTable.id)] },
    );

    const hydratedPosts = await postHydrationService.hydratePosts(scheduledPosts, {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
      operatedAccountIds: operatedChannelIds,
    });

    res.json({ posts: hydratedPosts });
  } catch (error) {
    logger.error('Error fetching scheduled posts', error);
    res.status(500).json({ message: 'Error fetching scheduled posts' });
  }
};

// Get nearby posts based on location
export const getNearbyPosts = async (req: AuthRequest, res: Response) => {
  try {
    const lat = queryString(req.query.lat);
    const lng = queryString(req.query.lng);
    const locationType = queryString(req.query.locationType) ?? 'content';

    if (!lat || !lng) {
      return res.status(400).json({ message: 'Latitude and longitude are required' });
    }

    const rawRadius = queryString(req.query.radius);
    const latitude = Number.parseFloat(lat);
    const longitude = Number.parseFloat(lng);
    const radiusMeters = rawRadius === undefined
      ? DEFAULT_NEARBY_RADIUS_METERS
      : Number.parseInt(rawRadius, 10);

    if (Number.isNaN(latitude) || Number.isNaN(longitude) || Number.isNaN(radiusMeters)) {
      return res.status(400).json({ message: 'Invalid latitude, longitude, or radius' });
    }

    if (locationType !== 'content' && locationType !== 'post') {
      return res.status(400).json({ message: 'locationType must be either "content" or "post"' });
    }

    const geoColumn = locationType === 'post' ? postsTable.geo : postsTable.contentGeo;
    const posts = await findPostRecords(
      and(
        eq(postsTable.visibility, 'public'),
        eq(postsTable.status, 'published'),
        withinRadius(geoColumn, longitude, latitude, radiusMeters),
      ),
      // Chronological, not nearest-first: `$near` sorts by distance, but the
      // Mongoose call overrode that with its own `createdAt` sort, so the
      // distance ordering was already discarded before this port.
      { orderBy: CHRONO_DESC, limit: MAX_NEARBY_POSTS },
    );

    const hydratedPosts = await postHydrationService.hydratePosts(posts, {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: false,
    });

    res.json({
      posts: hydratedPosts,
      center: { latitude, longitude },
      radius: radiusMeters,
      locationType,
      count: hydratedPosts.length
    });
  } catch (error) {
    logger.error('Error fetching nearby posts', error);
    res.status(500).json({ message: 'Error fetching nearby posts' });
  }
};

// Get posts within a bounding box area
export const getPostsInArea = async (req: AuthRequest, res: Response) => {
  try {
    const north = queryString(req.query.north);
    const south = queryString(req.query.south);
    const east = queryString(req.query.east);
    const west = queryString(req.query.west);
    const locationType = queryString(req.query.locationType) ?? 'content';

    if (!north || !south || !east || !west) {
      return res.status(400).json({
        message: 'Bounding box coordinates (north, south, east, west) are required'
      });
    }

    const northLat = Number.parseFloat(north);
    const southLat = Number.parseFloat(south);
    const eastLng = Number.parseFloat(east);
    const westLng = Number.parseFloat(west);

    if (Number.isNaN(northLat) || Number.isNaN(southLat) || Number.isNaN(eastLng) || Number.isNaN(westLng)) {
      return res.status(400).json({ message: 'Invalid bounding box coordinates' });
    }

    if (locationType !== 'content' && locationType !== 'post') {
      return res.status(400).json({ message: 'locationType must be either "content" or "post"' });
    }

    const geoColumn = locationType === 'post' ? postsTable.geo : postsTable.contentGeo;
    // `ST_MakeEnvelope(west, south, east, north, 4326)` — the same corner order
    // as Mongo's `$box`, and the same SRID the generated points carry. Cast to
    // `geography` so the comparison is against the column's own type; the `&&`
    // bounding-box operator is what the GiST index answers.
    const envelope = sql`ST_MakeEnvelope(${westLng}, ${southLat}, ${eastLng}, ${northLat}, 4326)::geography`;
    const posts = await findPostRecords(
      and(
        eq(postsTable.visibility, 'public'),
        eq(postsTable.status, 'published'),
        sql`${geoColumn} is not null and ${geoColumn} && ${envelope}`,
      ),
      { orderBy: CHRONO_DESC, limit: MAX_AREA_POSTS },
    );

    const hydratedPosts = await postHydrationService.hydratePosts(posts, {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: false,
    });

    res.json({
      posts: hydratedPosts,
      boundingBox: { north: northLat, south: southLat, east: eastLng, west: westLng },
      locationType,
      count: hydratedPosts.length
    });
  } catch (error) {
    logger.error('Error fetching posts in area', error);
    res.status(500).json({ message: 'Error fetching posts in area' });
  }
};

// Get nearby posts based on both user and post locations
// Get users who liked a post
export const getPostLikes = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const cursor = queryString(req.query.cursor);
    const limit = clampLikesLimit(queryInt(req.query.limit));

    if (!id) {
      return res.status(400).json({ message: 'Post ID is required' });
    }

    // `(created_at DESC, id DESC)`, not `_id DESC`. `likes.id` is `text` holding
    // an ObjectId hex for a row migrated from Mongo and a uuid v7 for anything
    // written since, and the two spaces interleave under text collation — so an
    // id-only bound behind an id-only sort is neither chronological nor stable
    // across the boundary, and would skip and repeat rows at every page edge.
    // Same keyset `getPostBoosts` below already uses.
    const conditions: SQL[] = [eq(likesTable.postId, String(id))];
    const parsedCursor = ChronoCursor.parse(cursor);
    if (parsedCursor?.ts !== undefined) {
      const boundaryAt = new Date(parsedCursor.ts);
      conditions.push(
        or(
          lt(likesTable.createdAt, boundaryAt),
          and(eq(likesTable.createdAt, boundaryAt), lt(likesTable.id, parsedCursor.id)),
        ) as SQL,
      );
    }

    const likes = await getDb()
      .select({ id: likesTable.id, userId: likesTable.userId, createdAt: likesTable.createdAt })
      .from(likesTable)
      .where(and(...conditions))
      .orderBy(desc(likesTable.createdAt), desc(likesTable.id))
      .limit(limit + 1);

    const hasMore = likes.length > limit;
    const likesToReturn = hasMore ? likes.slice(0, limit) : likes;
    const last = likesToReturn[likesToReturn.length - 1];
    const nextCursor = hasMore && last ? ChronoCursor.build(last.id, last.createdAt) : undefined;

    // Get unique user IDs, then resolve actor summaries through the same shared
    // resolver PostHydrationService uses (canonical `name.displayName`, batched
    // bulk fetch, Redis-cached) instead of N hand-built per-id Oxy reads.
    const userIds = [...new Set(likesToReturn.map(like => like.userId))];
    const summaries = await resolveUserSummaries(userIds);
    const users = userIds.map((userId) => mapActorSummary(userId, summaries.get(userId)?.user));

    res.json({
      users,
      hasMore,
      nextCursor,
      totalCount: likesToReturn.length
    });
  } catch (error) {
    logger.error('Error fetching post likes', error);
    res.status(500).json({ message: 'Error fetching post likes' });
  }
};

/**
 * Avatars shown in the known-likers row. Deliberately tiny: this is a face pile,
 * not a list — the real count travels separately as `total`.
 */
const KNOWN_LIKERS_SAMPLE_LIMIT = 3;

/**
 * Ceiling on the `$in` width of the follow-graph filter. Oxy already bounds the
 * viewer graph server-side, so this is a second, local guard that keeps the
 * index scan bounded no matter what the upstream cap becomes — mirroring
 * `MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED`, the same bound the feed applies to a
 * viewer-derived id list.
 */
const MAX_KNOWN_LIKER_CANDIDATES = 5000;

/**
 * Social proof for a focused post: the people the VIEWER follows who liked it,
 * as a 3-avatar sample plus the exact total.
 *
 * Deliberately NOT a flag on `GET /:id/likes`. That one is a cursor-paginated
 * engagement list of everybody; this is a fixed-size sample intersected with the
 * viewer's follow graph, and returns the `{ items, total }` shape the profile's
 * "Followed by" row already consumes.
 *
 * The follow graph is Oxy-owned and the likes are Mention-owned, so the two are
 * intersected here. The graph comes from the CONSOLIDATED viewer-graph read
 * (`getViewerGraph`), not `getUserFollowing`: it answers the same question with
 * an ids-only, server-bounded payload instead of a hydrated user DTO per follow.
 *
 * Query shape is what keeps it cheap, and the shape that matters is `userId`
 * bounded by a `$in` PLUS an exact `postId`: together they let the unique
 * `{ userId: 1, postId: 1 }` index answer with one seek per followed id, so the
 * work scales with the viewer's FOLLOW COUNT — bounded below — instead of with
 * the post's like count. (The order of the keys in the filter document is
 * irrelevant; MongoDB's planner picks an index by cost, not by BSON order.)
 *
 * Measured on a 150k-like post with a 5000-wide graph and no matches, which is
 * both the common case and the one no `limit` can short-circuit: 5000 keys and
 * ZERO documents examined on the compound index, against 150,000 keys AND
 * 150,000 documents when forced onto `{ postId: 1 }` (9ms vs 105ms). The
 * planner reaches for the compound index unaided in every case where the
 * difference matters, so there is deliberately no `hint()` — that leaves it
 * free to use `{ postId: 1 }` when it is genuinely cheaper, e.g. an unpopular
 * post, or a match sitting at the front of the scan.
 *
 * Anonymous viewers have no follow graph and therefore no social proof to show,
 * so they get an empty result with a 200 — never a 401. This is a decorative
 * read on a public post-detail screen; failing it closed with an auth error
 * would make signed-out detail views log an error per post.
 */
export const getKnownPostLikers = async (req: AuthRequest, res: Response) => {
  try {
    // Narrowed with `String` because Express types a route param as
    // `string | string[]`; a repeated param collapses to a comma-joined string,
    // which fails the id check below exactly like any other malformed value.
    const id = String(req.params.id ?? '');
    if (!id) {
      return res.status(400).json({ message: 'Post ID is required' });
    }

    const viewerId = req.user?.id;
    const oxyClient = createScopedOxyClient(req);
    if (!viewerId || !oxyClient) {
      return res.json({ likers: [], total: 0 });
    }

    const followingIds = extractFollowingIds(await oxyClient.getViewerGraph())
      .slice(0, MAX_KNOWN_LIKER_CANDIDATES);
    if (followingIds.length === 0) {
      return res.json({ likers: [], total: 0 });
    }

    const filter = and(
      inArray(likesTable.userId, followingIds),
      eq(likesTable.postId, id),
      eq(likesTable.value, 1),
    );

    // Unsorted on purpose: the unique `(user_id, post_id)` index answers this
    // with one seek per followed id, so any recency sort would add a blocking
    // sort over every match just to pick three avatars whose order carries no
    // meaning. `total` is exact.
    const db = getDb();
    const [likes, [totals]] = await Promise.all([
      db
        .select({ userId: likesTable.userId })
        .from(likesTable)
        .where(filter)
        .limit(KNOWN_LIKERS_SAMPLE_LIMIT),
      db.select({ total: sql<number>`count(*)::int` }).from(likesTable).where(filter),
    ]);

    const likerIds = [...new Set(likes.map((like) => like.userId))];
    const summaries = await resolveUserSummaries(likerIds);
    const likers = likerIds.map((likerId) => mapActorSummary(likerId, summaries.get(likerId)?.user));

    return res.json({ likers, total: totals?.total ?? 0 });
  } catch (error) {
    logger.error('Error fetching known post likers', error);
    return res.status(500).json({ message: 'Error fetching known post likers' });
  }
};

// Get users who boosted a post
export const getPostBoosts = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const cursor = queryString(req.query.cursor);
    const limit = clampLikesLimit(queryInt(req.query.limit));

    if (!id) {
      return res.status(400).json({ message: 'Post ID is required' });
    }

    // Chronological, matching the cursor it hands back. `_id DESC` used to be
    // both the order and the keyset, which agreed with each other while an
    // ObjectId encoded its creation time; with `posts.id` holding an ObjectId hex
    // for pre-cutover rows and a uuid v7 after, `id` order is neither
    // chronological nor stable across the boundary.
    const keyset = await chronoCursorSql(cursor);
    const conditions: SQL[] = [
      eq(postsTable.boostOf, String(id)),
      eq(postsTable.visibility, 'public'),
    ];
    if (keyset) conditions.push(keyset);

    const boosts = await getDb()
      .select({ id: postsTable.id, oxyUserId: postsTable.oxyUserId, createdAt: postsTable.createdAt })
      .from(postsTable)
      .where(and(...conditions))
      .orderBy(...chronoOrderBy())
      .limit(limit + 1);

    const hasMore = boosts.length > limit;
    const boostsToReturn = hasMore ? boosts.slice(0, limit) : boosts;
    const boostAnchor = hasMore ? boostsToReturn[limit - 1] : undefined;
    const nextCursor = boostAnchor
      ? ChronoCursor.build(boostAnchor.id, boostAnchor.createdAt)
      : undefined;

    // Get unique user IDs, then resolve actor summaries through the same shared
    // resolver PostHydrationService uses (canonical `name.displayName`, batched
    // bulk fetch, Redis-cached) instead of N hand-built per-id Oxy reads.
    const userIds = [...new Set(boostsToReturn.map(boost => boost.oxyUserId).filter((value): value is string => typeof value === 'string'))];
    const summaries = await resolveUserSummaries(userIds);
    const users = userIds.map((userId) => mapActorSummary(userId, summaries.get(userId)?.user));

    res.json({
      users,
      hasMore,
      nextCursor,
      totalCount: boostsToReturn.length
    });
  } catch (error) {
    logger.error('Error fetching post boosts', error);
    res.status(500).json({ message: 'Error fetching post boosts' });
  }
};

export const getNearbyPostsBothLocations = async (req: AuthRequest, res: Response) => {
  try {
    const lat = queryString(req.query.lat);
    const lng = queryString(req.query.lng);
    const rawRadius = queryString(req.query.radius);

    if (!lat || !lng) {
      return res.status(400).json({ message: 'Latitude and longitude are required' });
    }

    const latitude = Number.parseFloat(lat);
    const longitude = Number.parseFloat(lng);
    const radiusMeters = rawRadius === undefined
      ? DEFAULT_NEARBY_RADIUS_METERS
      : Number.parseInt(rawRadius, 10);

    if (Number.isNaN(latitude) || Number.isNaN(longitude) || Number.isNaN(radiusMeters)) {
      return res.status(400).json({ message: 'Invalid latitude, longitude, or radius' });
    }

    const posts = await findPostRecords(
      and(
        eq(postsTable.visibility, 'public'),
        eq(postsTable.status, 'published'),
        or(
          withinRadius(postsTable.contentGeo, longitude, latitude, radiusMeters),
          withinRadius(postsTable.geo, longitude, latitude, radiusMeters),
        ) as SQL,
      ),
      // Slightly higher limit since we're querying both location types
      { orderBy: CHRONO_DESC, limit: MAX_NEARBY_BOTH_LOCATIONS_POSTS },
    );

    const currentUserId = req.user?.id;
    const hydratedPosts = await postHydrationService.hydratePosts(posts, {
      viewerId: currentUserId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });

    res.json({
      posts: hydratedPosts,
      center: { latitude, longitude },
      radius: radiusMeters,
      locationType: 'both',
      count: hydratedPosts.length
    });
  } catch (error) {
    logger.error('Error fetching nearby posts (both locations)', error);
    res.status(500).json({ message: 'Error fetching nearby posts (both locations)' });
  }
};

// Get location statistics for analytics
export const getLocationStats = async (_req: AuthRequest, res: Response) => {
  try {
    // ONE grouped pass rather than five COUNTs over the same public/published
    // scan: each column is `NOT NULL`-tested inline. The pair CHECKs make
    // longitude and latitude present together, so testing one coordinate answers
    // for the point.
    const publicPublished = and(
      eq(postsTable.visibility, 'public'),
      eq(postsTable.status, 'published'),
    );
    const hasContentLocation = sql`${postsTable.contentLocationLatitude} is not null`;
    const hasPostLocation = sql`${postsTable.locationLatitude} is not null`;
    const [counts] = await getDb()
      .select({
        total: sql<number>`count(*)::int`,
        withContentLocation: sql<number>`count(*) filter (where ${hasContentLocation})::int`,
        withPostLocation: sql<number>`count(*) filter (where ${hasPostLocation})::int`,
        withBothLocations: sql<number>`count(*) filter (where ${hasContentLocation} and ${hasPostLocation})::int`,
        withAnyLocation: sql<number>`count(*) filter (where ${hasContentLocation} or ${hasPostLocation})::int`,
      })
      .from(postsTable)
      .where(publicPublished);

    const totalPosts = counts?.total ?? 0;
    const contentLocationCount = counts?.withContentLocation ?? 0;
    const postLocationCount = counts?.withPostLocation ?? 0;
    const bothLocationsCount = counts?.withBothLocations ?? 0;

    res.json({
      total: totalPosts,
      withContentLocation: contentLocationCount,
      withPostLocation: postLocationCount,
      withBothLocations: bothLocationsCount,
      withAnyLocation: counts?.withAnyLocation ?? 0,
      percentages: {
        contentLocation: totalPosts > 0 ? ((contentLocationCount / totalPosts) * 100).toFixed(2) : '0.00',
        postLocation: totalPosts > 0 ? ((postLocationCount / totalPosts) * 100).toFixed(2) : '0.00',
        bothLocations: totalPosts > 0 ? ((bothLocationsCount / totalPosts) * 100).toFixed(2) : '0.00'
      }
    });
  } catch (error) {
    logger.error('Error fetching location stats', error);
    res.status(500).json({ message: 'Error fetching location stats' });
  }
};

// ── Translate ──

/**
 * Map a failed translation onto a response. A {@link TranslationRequestError} is
 * the caller's fault and carries its own status; everything else is an Alia
 * outage, whose upstream status is parsed out of the thrown error so a rate limit
 * or a provider outage is not reported to the client as our own 500.
 */
const respondTranslationError = (res: Response, error: unknown, context: string): void => {
  if (error instanceof TranslationRequestError) {
    res.status(error.status).json({ message: error.message });
    return;
  }

  const errorMessage = error instanceof Error ? error.message : '';
  const statusMatch = errorMessage.match(/Alia API error (\d+)/);
  const aliaStatus = statusMatch ? parseInt(statusMatch[1], 10) : 0;

  if (aliaStatus === 429) {
    logger.warn(`${context}: rate limited`, error);
    res.status(429).json({ message: 'Too many requests. Please try again later.' });
  } else if (aliaStatus === 503 || aliaStatus === 502) {
    logger.warn(`${context}: translation service unavailable`, error);
    res.status(503).json({ message: 'Translation service temporarily unavailable.' });
  } else if (aliaStatus === 402) {
    logger.warn(`${context}: translation credits issue`, error);
    res.status(502).json({ message: 'Translation service unavailable.' });
  } else {
    logger.error(`${context}: translation failed`, error);
    res.status(500).json({ message: 'Translation failed' });
  }
};

/**
 * Translate a post on demand and cache the result ON the post, as a
 * `source: 'machine'` language variant — the same array the author's own variants
 * live in, so the next reader whose language ladder lands on it is served straight
 * from hydration. Any language is allowed (the machine cache is uncapped), and an
 * AUTHOR variant for the requested language short-circuits the model entirely.
 *
 * Visibility is enforced through hydration (the single ACL authority): a post this
 * viewer cannot see is a 404, exactly as it is on the read path.
 */
export const translatePost = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { targetLanguage, force } = req.body;

    const post = await loadPostRecord(String(id));
    if (!post) {
      res.status(404).json({ message: 'Post not found' });
      return;
    }

    const visiblePosts = await postHydrationService.hydratePosts([post], {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 0,
      includeLinkMetadata: false,
      includeFullArticleBody: false,
      includeFullMetadata: false,
    });
    if (visiblePosts.length === 0) {
      res.status(404).json({ message: 'Post not found' });
      return;
    }

    const translated = await postTranslationService.translatePost(
      post.id,
      post.content,
      targetLanguage,
      { force: force === true },
    );

    res.json({
      translatedText: translated.text,
      tag: translated.tag,
      cached: translated.cached,
    });
  } catch (error) {
    respondTranslationError(res, error, 'translatePost');
  }
};

/**
 * Translate a DRAFT body the composer is holding — there is no post yet, so
 * nothing is persisted. The result pre-fills a language tab as an editable draft;
 * what the author approves is what gets saved, as an AUTHOR variant.
 */
export const translateDraft = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }

    const { text, targetLanguage } = req.body;
    if (typeof text !== 'string') {
      res.status(400).json({ message: 'text is required' });
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      res.status(400).json({ message: `Post text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` });
      return;
    }

    const translated = await postTranslationService.translateDraft(text, targetLanguage);
    res.json({ translatedText: translated.text, tag: translated.tag });
  } catch (error) {
    respondTranslationError(res, error, 'translateDraft');
  }
};
