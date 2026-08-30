/**
 * `POST /posts` — the native single-post create.
 *
 * The thread create is `createThread`; the two share the payload readers in
 * `composeInput` and the storage/federation path in `PostCreationService`.
 */

import { Response } from 'express';
import { loadPostRecord } from '../../db/posts/postRepository';
import { attachPollToPost, createPollWithOptions } from '../../db/polls/pollRepository';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { PostVisibility, PostContent } from '@mention/shared-types';
import type { ReplyPermission } from '@mention/shared-types';
import { affinityEventService } from '../../services/AffinityEventService';
import { postCreationService } from '../../services/PostCreationService';
import { insertArticle, newArticleId } from '../../db/posts/articleRepository';
import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';
import { postHydrationService } from '../../services/PostHydrationService';
import { mergeHashtags } from '../../utils/textProcessing';
import { createScopedOxyClient, createUserScopedOxyServices } from '../../utils/oxyHelpers';
import { requestLanguageCandidates } from '../../utils/viewerLanguage';
import { normalizeMediaItems } from '../../utils/mediaInput';
import { warmLinkPreviewForText } from '../../utils/linkPreviewWarm';
import { resolveVariant, validateAuthorVariants } from '../../services/postVariants';
import { validatePublicShareTarget } from '../../utils/postAccessControl';
import { LaneAssignmentError } from '../../utils/laneAssignment';
import { assertParentAcceptsReplies, ChannelReplyError } from '../../utils/channelReplyGate';
import { PublishAsAccessError } from '../../services/publishAsAccount';
import { sanitizePodcast, resolvePodcastContent } from '../../utils/syraPodcast';
import { postCollaborationService, CollabValidationError } from '../../services/PostCollaborationService';
import { resolveMcpAutoAcceptIds } from '../../mcp/utils/resolveMcpAutoAcceptIds';
import {
  type PendingArticle,
  MAX_ARTICLE_EXCERPT_LENGTH,
  DEFAULT_POLL_DURATION_DAYS,
  MAX_POLL_DURATION_DAYS,
  MAX_TEXT_LENGTH,
  buildOrderedAttachments,
  hashtagsSchema,
  parseFailureMessage,
  pollInputSchema,
  postVisibilitySchema,
  replyPermissionSchema,
  buildPostMetadata,
  sanitizeArticle,
  sanitizeEventData,
  sanitizeRoomData,
  sanitizeSources,
} from './composeInput';

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

    // Validate hashtags. The bounds are the ones this route already answered a
    // 400 for; the `Array.isArray` guard they sat behind was the defect, because
    // it SKIPPED them for a non-array and then handed that value to
    // `mergeHashtags` anyway — `(userProvided || []).map` on a string is a
    // `TypeError`, and `hashtags: "cat"` was a 500 on the busiest write here.
    // A falsy value still means "no tags", exactly as `(x || [])` did.
    let parsedHashtags: string[] | undefined;
    if (hashtags) {
      const parsed = hashtagsSchema.safeParse(hashtags);
      if (!parsed.success) {
        return res.status(400).json({ message: parseFailureMessage(parsed.error) });
      }
      parsedHashtags = parsed.data;
    }

    // Extract and merge hashtags from text with user-provided ones
    const uniqueTags = mergeHashtags(text || '', parsedHashtags);

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
      // The poll's SHAPE, before its deadline and before anything is inserted.
      // `question` and `options` used to reach `createPollWithOptions` unread, so
      // an object question was stored as the literal `'[object Object]'`, two
      // hundred options became two hundred rows, and an empty `options` array
      // published a post carrying a poll nobody can answer. The `catch` below
      // still stands, but it is now the answer to a database failure rather than
      // the only thing standing between the composer and the table.
      const parsedPoll = pollInputSchema.safeParse(poll);
      if (!parsedPoll.success) {
        return res.status(400).json({ message: parseFailureMessage(parsedPoll.error) });
      }
      const pollInput = parsedPoll.data;

      // Validate poll endTime is in the future and within max duration
      if (pollInput.endTime) {
        const endTimeMs = new Date(pollInput.endTime).getTime();
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
          question: pollInput.question,
          options: pollInput.options,
          createdBy: userId,
          endsAt: new Date(pollInput.endTime || Date.now() + DEFAULT_POLL_DURATION_DAYS * 24 * 60 * 60 * 1000),
          isMultipleChoice: pollInput.isMultipleChoice || false,
          isAnonymous: pollInput.isAnonymous || false,
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

    // The same reader `POST /posts/thread` uses, with the fallback this route has
    // always had: a value it does not recognise becomes `public` rather than a
    // refusal. That default is deliberately UNCHANGED — narrowing it would refuse
    // bodies that publish today — and it is why the shared schema reports an
    // unrecognised value instead of assuming one.
    const parsedVisibility = postVisibilitySchema.safeParse(req.body.visibility);
    const resolvedVisibility = parsedVisibility.success ? parsedVisibility.data : PostVisibility.PUBLIC;

    // `replyPermission` reaches a `text[]` column guarded by
    // `posts_reply_permission_check`, and used to reach it as `x || ['anyone']` —
    // so `['banana']` was a check violation and a bare `'nobody'` was a
    // `TypeError` inside the driver, both 500s. A falsy value still means
    // "not supplied"; an EMPTY array is still stored as one.
    let parsedReplyPermission: ReplyPermission[] | undefined;
    if (replyPermission) {
      const parsed = replyPermissionSchema.safeParse(replyPermission);
      if (!parsed.success) {
        return res.status(400).json({ message: parseFailureMessage(parsed.error) });
      }
      parsedReplyPermission = parsed.data;
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
      replyPermission: parsedReplyPermission ?? ['anyone'],
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
      // A post scheduled or drafted AS A CHANNEL is withheld the instant it is
      // written, and its author is the channel — so without current authority
      // here the ACL refuses the response to the person who just created it, and
      // the 500 below fires on a write that succeeded. Free for the ordinary
      // case: a published post asks Oxy nothing.
      operatedAccountReader: createUserScopedOxyServices(req),
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
