/**
 * `POST /posts/thread` — the native multi-post create.
 *
 * A chain is published through `PostCreationService.federatePublishedPost` and
 * stops at the first entry that does not go out, so the whole chain is built
 * here in one place rather than by looping `createPost`.
 */

import { Response } from 'express';
import { updatePostRecord } from '../../db/posts/postRepository';
import type { PostRecord } from '../../db/posts/postRecord';
import { attachPollToPost, createPollWithOptions } from '../../db/polls/pollRepository';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { createMentionNotifications } from '../../utils/notificationUtils';
import { PostVisibility, PostContent, PostContentVariant } from '@mention/shared-types';
import type { ReplyPermission } from '@mention/shared-types';
import { postCreationService } from '../../services/PostCreationService';
import { insertArticle, newArticleId } from '../../db/posts/articleRepository';
import { logger } from '../../utils/logger';
import { postHydrationService } from '../../services/PostHydrationService';
import { mergeHashtags } from '../../utils/textProcessing';
import { createScopedOxyClient, createUserScopedOxyServices } from '../../utils/oxyHelpers';
import { requestLanguageCandidates } from '../../utils/viewerLanguage';
import { getRuntimeSocketServer } from '../../runtime/socketServer';
import { normalizeMediaItems } from '../../utils/mediaInput';
import { warmLinkPreviewForText } from '../../utils/linkPreviewWarm';
import { resolveVariant, validateAuthorVariants } from '../../services/postVariants';
import { assertLaneAssignable, LaneAssignmentError } from '../../utils/laneAssignment';
import type { AccountKind } from '@oxyhq/contracts';
import {
  assertCanPublishAsAccount,
  cacheAccountMemberReads,
  PublishAsAccessError,
} from '../../services/publishAsAccount';
import { sanitizePodcast, resolvePodcastContent } from '../../utils/syraPodcast';
import { federatePostBatchDetached } from '../../connectors/threadFederation';
import {
  type ParsedPollInput,
  type PendingArticle,
  MAX_ARTICLE_EXCERPT_LENGTH,
  DEFAULT_POLL_DURATION_DAYS,
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
     * Every other client-supplied field of an entry, validated for the WHOLE
     * batch before a single row is written — the same reason the variants,
     * lanes, collaborators and accounts above are.
     *
     * These four reached the write unread. `hashtags` went to `mergeHashtags`,
     * which calls `.map` on whatever it is given, so a string was a `TypeError`;
     * `visibility` was `(visibility as PostVisibility) || PUBLIC`, a cast of
     * request input into a column guarded by `posts_visibility_check`;
     * `replyPermission` reached a `text[]` guarded by
     * `posts_reply_permission_check` with no cast at all; and the poll's question
     * and options were inserted verbatim, unbounded, by a call this loop does not
     * even wrap in a `try`. Every one of them was a 500 raised INSIDE the
     * creation loop — on entry three, with entries one and two already published
     * and no single action able to undo them.
     *
     * Only a TRUTHY value is parsed, because each of these was written as
     * `value || <default>`: a falsy one has always selected the default.
     */
    const entryHashtags: Array<string[] | undefined> = [];
    const entryVisibility: Array<PostVisibility | undefined> = [];
    const entryReplyPermission: Array<ReplyPermission[] | undefined> = [];
    const entryPolls: Array<ParsedPollInput | undefined> = [];
    for (const entry of posts) {
      if (entry?.hashtags) {
        const parsed = hashtagsSchema.safeParse(entry.hashtags);
        if (!parsed.success) {
          return res.status(400).json({ message: parseFailureMessage(parsed.error) });
        }
        entryHashtags.push(parsed.data);
      } else {
        entryHashtags.push(undefined);
      }

      if (entry?.visibility) {
        // REFUSED rather than defaulted, unlike `POST /posts`. A batch cannot
        // fall back: publishing n posts to `public` because one word was not
        // recognised is not a default anybody asked for, and the alternative —
        // letting it reach the column — is the half-thread this loop prevents.
        const parsed = postVisibilitySchema.safeParse(entry.visibility);
        if (!parsed.success) {
          return res.status(400).json({ message: parseFailureMessage(parsed.error) });
        }
        entryVisibility.push(parsed.data);
      } else {
        entryVisibility.push(undefined);
      }

      if (entry?.replyPermission) {
        const parsed = replyPermissionSchema.safeParse(entry.replyPermission);
        if (!parsed.success) {
          return res.status(400).json({ message: parseFailureMessage(parsed.error) });
        }
        entryReplyPermission.push(parsed.data);
      } else {
        entryReplyPermission.push(undefined);
      }

      if (entry?.content?.poll) {
        const parsed = pollInputSchema.safeParse(entry.content.poll);
        if (!parsed.success) {
          return res.status(400).json({ message: parseFailureMessage(parsed.error) });
        }
        // The deadline is only checked for being READABLE. `POST /posts` also
        // requires it to be in the future and within `MAX_POLL_DURATION_DAYS`;
        // this path never has, and applying those here would refuse threads that
        // publish today. What it could not survive is an UNREADABLE one, which
        // is `ends_at`'s NOT NULL constraint raised mid-batch.
        if (parsed.data.endTime && Number.isNaN(new Date(parsed.data.endTime).getTime())) {
          return res.status(400).json({ message: 'Invalid poll end time' });
        }
        entryPolls.push(parsed.data);
      } else {
        entryPolls.push(undefined);
      }
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
      const { content, mentions, reviewReplies, quotesDisabled, metadata } = postData;

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
      const poll = entryPolls[i];
      if (poll) {
        // Same shared writer as the single-post path above, from the SAME
        // validated shape — pre-flighted with the rest of the batch, because this
        // call is not wrapped in a `try` and a poll that fails to insert on entry
        // three would 500 with entries one and two already published.
        pollId = await createPollWithOptions({
          question: poll.question,
          options: poll.options,
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
      const uniqueTags = mergeHashtags(postContent.text ?? '', entryHashtags[i]);

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
        visibility: entryVisibility[i] ?? PostVisibility.PUBLIC,
        replyPermission: entryReplyPermission[i] ?? ['anyone'],
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
      // Same reason as `createPost`: a SCHEDULED batch is withheld from the
      // moment it is written, and a batch published as a channel is authored by
      // the channel — so the response would otherwise come back empty to the
      // person who just wrote the thread.
      operatedAccountReader: createUserScopedOxyServices(req),
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
