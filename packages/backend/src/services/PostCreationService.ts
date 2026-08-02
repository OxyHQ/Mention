import { Post, IPost, PostFederationData, POST_CLASSIFICATION_PENDING } from '../models/Post';
import {
  PostType,
  PostVisibility,
  PostContent,
  PostContentVariant,
  MediaItem,
  StoredPostContent,
} from '@mention/shared-types';
import {
  mentionTextsFromContent,
} from '@mention/shared-types/mentions';
import { reconcileMentionIdsForPost } from '../utils/textProcessing';
import {
  createMentionNotifications,
  createBatchNotifications,
  createPostAuthorNotifications,
} from '../utils/notificationUtils';
import PostSubscription from '../models/PostSubscription';
import { logger } from '../utils/logger';
import { getRuntimeSocketServer } from '../runtime/socketServer';
import { getPostFederator, registerPostCreator } from './serviceRegistry';
import { baselineContentClassifier } from './BaselineContentClassifier';
import { postHydrationService } from './PostHydrationService';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { emitPostCreated, emitRepostCreated } from './mtn/MentionRecordEmitter';
import type { ReplyContext } from './mtn/mentionRecordBuilders';
import { postCollaborationService } from './PostCollaborationService';
import { getOwnerId, hasPendingCollabInvites } from '../utils/postAuthorship';
import { mediaMetadataService } from './MediaMetadataService';
import { enrichIngestedPosts } from './postEnrichment';
import {
  applyDetectedPrimaryTag,
  authorVariants,
  buildPrimaryVariant,
  declaredBaseLanguages,
} from './postVariants';
import { recordRecentReplierForPost } from './PostRecentReplierService';
import { parentHasPublished } from './scheduledChain';
import { assertLaneAssignable } from '../utils/laneAssignment';
import {
  assertCanPublishAsAccount,
  PublishAsAccessError,
  type AccountMemberReader,
} from './publishAsAccount';

export interface CreatePostParams {
  /**
   * The AUTHENTICATED caller. This is the post's author UNLESS
   * {@link CreatePostParams.publishAsOxyUserId} names another account, in which
   * case the caller becomes `writtenByOxyUserId` and the post is authored by that
   * account instead. `null` only on ingest paths that resolve their own author.
   */
  oxyUserId: string | null;
  content: PostContent;
  visibility?: PostVisibility;
  parentPostId?: string | null;
  threadId?: string | null;
  quoteOf?: string | null;
  boostOf?: string | null;
  /**
   * The author's own lane for this post — local curation only: it never
   * federates, never enters an MTN record, and never changes distribution.
   * Validated by {@link assertLaneAssignable} before the document is built, so a
   * lane belonging to somebody else, or one attached to a reply or a boost, is
   * REFUSED rather than silently dropped (an author told nothing would go on
   * believing they published in a lane).
   */
  laneId?: string | null;
  /**
   * Publish this post AS another Oxy account the caller operates — today, a
   * `channel` account.
   *
   * The post is AUTHORED BY that account: it carries the account's `oxyUserId`
   * and its `authorship`, so it lands on that account's profile and in the
   * timelines of its followers, and it renders with its avatar and name. The
   * authenticated human moves to `writtenByOxyUserId`, OUTSIDE `authorship` —
   * putting them inside would both break the channel's anonymity and put the post
   * back on their own profile.
   *
   * Validated by {@link assertCanPublishAsAccount} before the document is built:
   * an account the caller is not an accepted member of is a 403. Publishing as a
   * channel also forces `replyPermission: ['nobody']` — see there.
   */
  publishAsOxyUserId?: string | null;
  /**
   * The Oxy client {@link publishAsOxyUserId} is authorized with — the CALLER'S
   * own, because Oxy scopes `GET /accounts/:id/members` to the authenticated user
   * and does not honour service-token delegation on that router.
   *
   * It is a parameter rather than something this service reaches for, because
   * this service has no request to reach into; the alternative — checking in the
   * controller and passing a "yes it's fine" flag — is exactly the shape that
   * lets a future caller route around the gate. Absent ⇒ no publish-as is
   * authorizable, so naming an account without one is a 403.
   */
  memberReader?: AccountMemberReader;
  hashtags?: string[];
  mentions?: string[];
  language?: string;
  // Full declared language set for federated posts (AP top-level `language` +
  // every `contentMap` key, via `extractApLanguages`). Authoritative for the
  // Stage-A classifier's `postClassification.languages`; the top-level
  // `post.language` continues to use the singular `language` param.
  languages?: string[];
  location?: {
    type: 'Point';
    coordinates: [number, number];
    address?: string;
  } | null;
  status?: 'draft' | 'published' | 'scheduled';
  scheduledFor?: Date;
  replyPermission?: string[];
  reviewReplies?: boolean;
  quotesDisabled?: boolean;
  metadata?: Record<string, unknown>;
  // Federation fields — only for incoming federated posts
  federation?: PostFederationData;
  // Stage-A baseline classification inputs for federated posts. The federation
  // ingest paths pass the AP-derived instance host so the deterministic
  // classifier can resolve a coarse region. (Language is threaded through the
  // existing `language` param so it also fixes the top-level `post.language`.)
  instanceDomain?: string;
  // AP actor type of the author (`Person`/`Service`/`Application`/…), passed by
  // the federation ingest paths so the deterministic classifier can flag RSS/bot
  // mirrors. Absent for native posts (neutral).
  actorType?: string;
  // Caller-supplied username enables outbound ActivityPub federation delivery.
  // When omitted, federation delivery is skipped.
  senderUsername?: string;
  // Pipeline control flags
  skipNotifications?: boolean;
  skipSocketEmit?: boolean;
  skipFederationDelivery?: boolean;
  /** Local Oxy user ids to invite as collaborators (max 5). */
  collaboratorIds?: string[];
  /** IDs of collaborators to auto-accept after save (e.g. linked MCP bundle members). */
  autoAcceptCollaboratorIds?: string[];
  // Override timestamps for federated posts with original publish dates
  createdAt?: Date;
  updatedAt?: Date;
}

function derivePostType(params: CreatePostParams): PostType {
  if (params.boostOf) return PostType.BOOST;
  if (params.quoteOf) return PostType.QUOTE;
  const media = params.content.media;
  if (Array.isArray(media) && media.length > 0) {
    const hasVideo = (media as MediaItem[]).some((m) => m.type === 'video');
    return hasVideo ? PostType.VIDEO : PostType.IMAGE;
  }
  return PostType.TEXT;
}

class PostCreationService {
  /**
   * Compute the deterministic Stage-A classification subdoc for a post and merge
   * it onto the post data, keeping `status: 'pending'` so the async AI batch
   * (PostClassificationService) still enriches the post afterward.
   *
   * Best-effort and non-fatal: classification MUST NEVER block or fail post
   * creation. The classifier is pure/synchronous so it should not throw, but any
   * throw is caught + logged at warn and the post is still saved with the default
   * `pending` subdoc untouched.
   */
  private applyBaselineClassification(
    postData: Record<string, unknown>,
    params: CreatePostParams,
    primaryText: string,
  ): void {
    try {
      const isFederated = params.federation != null;
      const metadataSensitive = (params.metadata as { isSensitive?: boolean } | undefined)?.isSensitive;
      // What the post DECLARES: the federated ingest paths pass `params.languages`
      // (AP `language` + every `contentMap` key); a native post declares the base
      // subtags of the author's own language variants (primary first). Either way
      // the classifier prefers a declared set over tinyld detection — a bilingual
      // post reaches BOTH audiences without the detector having to guess.
      //
      // An author who declared NOTHING contributes no languages here, so detection
      // runs on the body and stays free to revise itself on a later edit. Never
      // infer a language from the client's UI locale: the classifier trusts a
      // declaration over the detector, so an English-locale app writing Spanish
      // would stamp `en` on Spanish posts and the feed would serve them to the
      // wrong language audience, network-wide and silently.
      const declaredLanguages = params.languages ?? declaredBaseLanguages(params.content);
      const signals = baselineContentClassifier.classify({
        text: primaryText,
        hashtags: params.hashtags,
        language: params.language,
        languages: declaredLanguages,
        sensitive: params.federation?.sensitive ?? metadataSensitive,
        isFederated,
        instanceDomain: params.instanceDomain,
        actorType: params.actorType,
      });

      // Populate the Stage-A deterministic fields but LEAVE status 'pending' so
      // the AI batch's unclassified filter still picks the post up. The
      // deterministic `scores` are written so ranking can downrank spam/low-quality
      // posts before any AI runs; the AI batch OVERWRITES `scores` wholesale when a
      // key is configured (the intended hybrid). The classification subdoc carries
      // ONLY the multi-language `languages` array — there is no single-value field.
      postData.postClassification = {
        status: POST_CLASSIFICATION_PENDING,
        attempts: 0,
        topics: signals.topics,
        languages: signals.languages,
        region: signals.region,
        hashtagsNorm: signals.hashtagsNorm,
        trendTerms: signals.trendTerms,
        sensitive: signals.sensitive,
        scores: signals.scores,
        version: signals.version,
        classifiedAt: new Date(signals.classifiedAt),
      };

      // Keep the top-level AP `post.language` (single, protocol-facing) in sync
      // with the resolved primary (`languages[0]`, already normalized to ISO
      // 639-1). When the classifier could not resolve any language, the raw
      // `params.language` set earlier (if any) is left untouched.
      const primaryLanguage = signals.languages[0];
      if (primaryLanguage != null) {
        postData.language = primaryLanguage;
      }
    } catch (error) {
      // Never block creation on classification — fall back to the schema default
      // (`{ status: 'pending' }`) so the AI batch still processes the post.
      logger.warn('PostCreationService: baseline classification failed; saving without Stage-A signals', error);
    }
  }

  /**
   * MTN Protocol dual-write: emit the signed record for a just-created post.
   *
   * Boosts emit `app.mention.feed.repost`; everything else (top-level posts,
   * replies, quotes) emits `app.mention.feed.post`. For a reply, the `reply.root`
   * / `reply.parent` MTN URIs need the OWNER oxyUserId of the referenced posts,
   * resolved here with a single lean lookup. Entirely best-effort and isolated by
   * the emitter — a failure NEVER blocks creation or changes the response.
   */
  private async emitMtnRecord(post: IPost): Promise<void> {
    try {
      if (post.federation != null || !post.oxyUserId) {
        return;
      }

      if (post.boostOf) {
        const original = await Post.findById(post.boostOf).select('oxyUserId').lean();
        await emitRepostCreated(post, String(post.boostOf), original?.oxyUserId);
        return;
      }

      let reply: ReplyContext | undefined;
      if (post.parentPostId) {
        const rootId = post.threadId ?? post.parentPostId;
        const ids = [...new Set([String(post.parentPostId), String(rootId)])];
        const refs = await Post.find({ _id: { $in: ids } }).select('oxyUserId').lean();
        const ownerById = new Map(refs.map((r) => [String(r._id), r.oxyUserId]));
        const parentOwner = ownerById.get(String(post.parentPostId));
        const rootOwner = ownerById.get(String(rootId));
        if (parentOwner && rootOwner) {
          reply = {
            root: { postId: String(rootId), oxyUserId: rootOwner },
            parent: { postId: String(post.parentPostId), oxyUserId: parentOwner },
          };
        }
      }

      await emitPostCreated(post, { reply });
    } catch (error) {
      // Defensive: the emitter already isolates failures, but guard the resolve
      // step too so the dual-write can never surface as a creation error.
      logger.error('PostCreationService: MTN record emission failed', error);
    }
  }

  /**
   * Create a Post document and run the standard side-effect pipeline:
   * mention notifications, reply/quote/boost notifications, subscriber
   * notifications, socket emission, and federation delivery.
   *
   * Pass `skipNotifications`, `skipSocketEmit`, or `skipFederationDelivery`
   * to suppress individual stages (e.g. for incoming federated posts).
   */
  /**
   * Turn the content a CALLER supplies (the API shape: a plain `text` body, or an
   * explicit set of author variants) into the content we STORE (renditions only —
   * `variants[0]` is the primary and the sole home of the body).
   *
   * When the author declared variants, those ARE the renditions. Otherwise the
   * single body becomes the primary variant, tagged with whatever language was
   * resolved for the post — the author's declaration if they made one, else the
   * classifier's detection (a bare base code: the region is unknown and inventing
   * one would federate a guess). A post whose language nothing could resolve keeps
   * an untagged primary; a post with no body at all (a boost) keeps no variant.
   */
  private buildStoredContent(
    content: PostContent,
    inputVariants: PostContentVariant[],
    primaryLanguage: string | undefined,
  ): StoredPostContent {
    const primary = buildPrimaryVariant(content.text, primaryLanguage);
    const variants = inputVariants.length > 0
      ? applyDetectedPrimaryTag(inputVariants, primaryLanguage)
      : (primary ? [primary] : []);

    // An explicit whitelist, not a spread of the request shape: `text` (and the
    // hydration-only `textLang`) must NOT reach storage — they are the API's view
    // of the body, and the body lives on the rendition. The post-level facts below
    // are deliberately not per-language: a poll's votes must aggregate (two polls
    // would split the count), and a location or a citation is a fact about the
    // post, not about a language.
    return {
      ...(variants.length > 0 ? { variants } : {}),
      media: content.media,
      article: content.article,
      poll: content.poll,
      pollId: content.pollId,
      location: content.location,
      sources: content.sources,
      event: content.event,
      room: content.room,
      podcast: content.podcast,
      attachments: content.attachments,
    };
  }

  async create(params: CreatePostParams): Promise<IPost> {
    const isScheduled = params.status === 'scheduled';

    // BEFORE anything is built or written, and in this order: WHO the post is
    // authored by, then whether the lane belongs to that author. The publish-as
    // gate runs first because it decides which publisher the lane gate then
    // measures the lane against.
    //
    // A reply, a boost and a federated ingest can never be published as another
    // account: a channel takes no replies at all, a boost has no body of its own
    // (it renders unwrapped and its own row belongs to the booster), and a
    // federated post's author is resolved from the remote actor, so a second
    // author on the same row could only contradict it. Each is a REFUSAL rather
    // than a silent drop — an author told nothing would go on believing they had
    // published as the channel.
    if (params.publishAsOxyUserId) {
      if (params.parentPostId) {
        throw new PublishAsAccessError(400, 'A reply cannot be published as another account');
      }
      if (params.boostOf) {
        throw new PublishAsAccessError(400, 'A boost cannot be published as another account');
      }
      if (params.federation != null) {
        throw new PublishAsAccessError(400, 'A federated post cannot be published as another account');
      }
    }

    // The post's AUTHOR. Everything downstream — `oxyUserId`, `authorship`, the
    // lane's publisher, the notification actor, the federation identity, the MTN
    // record's subject — reads this, never `params.oxyUserId`, so the authorship
    // and the authorization can never disagree. The authenticated human survives
    // only as `writtenByOxyUserId`, outside `authorship`.
    const authorId = await assertCanPublishAsAccount({
      publishAsOxyUserId: params.publishAsOxyUserId,
      callerId: params.oxyUserId,
      memberReader: params.memberReader,
    });
    const publishedAsAccount = authorId !== null && authorId !== params.oxyUserId;

    await assertLaneAssignable({
      laneId: params.laneId,
      authorId,
      parentPostId: params.parentPostId,
      boostOf: params.boostOf,
    });

    let content = params.content;
    if (Array.isArray(content.media) && content.media.length > 0) {
      const enrichedMedia = await mediaMetadataService.enrichFromOxy(content.media as MediaItem[]);
      content = { ...content, media: enrichedMedia };
    }

    // The post's primary body, whichever shape the caller used: the first author
    // variant when the author declared languages, else the plain `text` field.
    const inputVariants = authorVariants(content);
    const primaryText = inputVariants[0]?.text ?? content.text ?? '';

    // Defense-in-depth against blank federated posts. `buildFederatedNoteContent`
    // is the PRIMARY guard on the ingest paths, but the outbox backfill inserts
    // raw docs via `Post.collection.insertMany` and bypasses this method entirely,
    // so a federated Note that reaches `create` must never persist an empty body:
    // no text, no media, no attachments, no poll, and no content-warning summary
    // is a blank post with nothing to render. Reject it loudly rather than store a
    // ghost. Native (non-federated) posts are unaffected — this only guards the
    // federated branch.
    if (params.federation != null) {
      const hasText = primaryText.trim().length > 0;
      const hasMedia = Array.isArray(content.media) && content.media.length > 0;
      const hasAttachments = Array.isArray(content.attachments) && content.attachments.length > 0;
      const hasPoll = content.poll != null || (typeof content.pollId === 'string' && content.pollId.length > 0);
      const hasSummary =
        typeof params.federation.spoilerText === 'string' && params.federation.spoilerText.trim().length > 0;
      if (!hasText && !hasMedia && !hasAttachments && !hasPoll && !hasSummary) {
        throw new Error(
          `PostCreationService: refusing to create empty federated post (activityId=${params.federation.activityId ?? 'unknown'})`,
        );
      }
    }

    const postData: Record<string, unknown> = {
      type: derivePostType({ ...params, content }),
      visibility: params.visibility ?? PostVisibility.PUBLIC,
      hashtags: params.hashtags ?? [],
      // Filled from the finalized stored bodies below. Incoming metadata alone
      // must never create a notification recipient.
      mentions: [],
      quoteOf: params.quoteOf ?? null,
      boostOf: params.boostOf ?? null,
      parentPostId: params.parentPostId ?? null,
      threadId: params.threadId ?? null,
      // A channel post is persisted with `['nobody']` whatever the caller asked
      // for — DEFENCE IN DEPTH, and it buys the client's existing reply-button
      // suppression with no new UI. It is NOT what the server's refusal rests on:
      // `utils/channelReplyGate` reads the AUTHOR's account kind, because this
      // field is mutable and a later settings write must not be able to reopen
      // the post.
      replyPermission: publishedAsAccount ? ['nobody'] : params.replyPermission ?? ['anyone'],
      reviewReplies: params.reviewReplies ?? false,
      quotesDisabled: params.quotesDisabled ?? false,
      status: params.status ?? 'published',
      metadata: params.metadata ?? {},
      stats: {
        likesCount: 0,
        boostsCount: 0,
        commentsCount: 0,
        viewsCount: 0,
        sharesCount: 0,
        savesCount: 0,
      },
    };

    if (authorId != null) {
      postData.oxyUserId = authorId;
      const collaboratorIds = params.collaboratorIds ?? [];
      if (collaboratorIds.length > 0) {
        postData.authorship = postCollaborationService.buildAuthorship(authorId, collaboratorIds);
        postData.metadata = { ...(postData.metadata as Record<string, unknown>), collabFederationDeferred: true };
      } else {
        postData.authorship = postCollaborationService.buildAuthorship(authorId, []);
      }
    }
    // The human behind a channel post — recorded OUTSIDE `authorship`, which is
    // what keeps the post off their own profile and their name out of the byline.
    // Set only when the author is somebody else, so an ordinary post never
    // duplicates its own author here.
    if (publishedAsAccount && params.oxyUserId) {
      postData.writtenByOxyUserId = params.oxyUserId;
    }
    if (params.federation != null) {
      postData.federation = params.federation;
    }
    if (params.location != null) {
      postData.location = params.location;
    }
    // Set only when there IS a lane — never as an explicit `null`. The
    // `post_lane_chrono_v1` partial filter is `{ laneId: { $exists: true } }`,
    // which a stored `null` satisfies, so writing one would index every post in
    // the collection and defeat the whole point of the partial index.
    if (params.laneId) {
      postData.laneId = params.laneId;
    }
    if (params.language != null) {
      postData.language = params.language;
    }
    if (params.scheduledFor != null) {
      postData.scheduledFor = params.scheduledFor;
    }
    if (params.createdAt != null) {
      postData.createdAt = params.createdAt;
    }
    if (params.updatedAt != null) {
      postData.updatedAt = params.updatedAt;
    }

    // Stage-A deterministic classification (native + single-federated paths).
    // Best-effort: keeps `status: 'pending'` so the AI batch still enriches it.
    // It runs BEFORE the content is built because the language it resolves is what
    // tags the primary variant when the author declared none.
    this.applyBaselineClassification(postData, params, primaryText);

    const primaryLanguage = typeof postData.language === 'string' ? postData.language : undefined;
    const storedContent = this.buildStoredContent(content, inputVariants, primaryLanguage);
    postData.content = storedContent;
    postData.mentions = reconcileMentionIdsForPost(
      mentionTextsFromContent(storedContent),
      params.mentions,
    );

    const post = new Post(postData);
    await post.save();
    await recordRecentReplierForPost(post);

    const isPublished = (post.status ?? 'published') === 'published';

    // Post-ingest enrichment, converged with the outbox backfill's raw-insert
    // route on one entry point (see `services/postEnrichment/`). Deferred while
    // the post is still scheduled: a scheduled post has no readers yet, and
    // `publishScheduledPost` runs the same step when it goes live. That gate is
    // also why link previews were silently missing for every scheduled post —
    // the old per-call-site fan-out skipped the warm here and the publish step
    // never had one.
    if (isPublished) {
      enrichIngestedPosts([post]);
    }

    if (
      params.autoAcceptCollaboratorIds &&
      params.autoAcceptCollaboratorIds.length > 0
    ) {
      await postCollaborationService.autoAcceptInvites(
        post,
        new Set(params.autoAcceptCollaboratorIds),
      );
    }

    const hasPendingInvites = hasPendingCollabInvites(post.authorship ?? []);

    if (isPublished && hasPendingInvites && authorId) {
      await postCollaborationService.notifyPendingInvites(post, authorId);
    }

    const postMeta = (post.metadata ?? {}) as Record<string, unknown>;
    const skipFederation =
      params.skipFederationDelivery ||
      hasPendingCollabInvites(post.authorship ?? []) ||
      postMeta.federationDelivered === true;

    // MTN Protocol dual-write (best-effort, never blocks, never changes output).
    // Mongo is authoritative; this emits a signed `app.mention.feed.*` record for
    // LOCAL authors only (`federation == null && oxyUserId`). A scheduled post is
    // not yet published, so it emits when the scheduler publishes it, not here.
    if (!isScheduled) {
      await this.emitMtnRecord(post);
    }

    if (isScheduled || params.skipNotifications) {
      return post;
    }

    await this.runPostSideEffects(post, {
      oxyUserId: authorId,
      senderUsername: params.senderUsername,
      skipSocketEmit: params.skipSocketEmit,
      skipFederation,
    });

    return post;
  }

  /**
   * CLAIM a scheduled post, then publish it.
   *
   * The claim is the point. `publishScheduledPost` flips the status on a
   * document it was handed, so two callers holding the same document both run
   * the whole pipeline — federating twice, writing two MTN records, notifying
   * twice. That is reachable in practice: the 60s sweep may load a due post
   * moments before its author taps "post now".
   *
   * `findOneAndUpdate` filtered on `status: 'scheduled'` is the mutual
   * exclusion. Exactly one caller can match and flip; every later one matches
   * nothing and gets `null`, because the winner already moved the post out of
   * the filter — the SAME filter the sweep selects on, so the sweep is excluded
   * too. `publishScheduledPost` then re-sets the status it already holds, which
   * is a no-op, and runs the side effects exactly once.
   *
   * `ownerId` narrows the claim to one author for the request path. The sweep
   * omits it, since it publishes on nobody's behalf.
   *
   * **A continuation is refused while its parent is still unpublished.** A
   * scheduled thread's posts are replies to one another, so publishing one out
   * of turn puts an answer on screen ahead of the post it answers — a broken
   * thread real readers can see, with no way to reorder it afterwards. The check
   * lives HERE, at the one chokepoint both the sweep and the author's "publish
   * now" go through, so the invariant does not depend on any caller ordering its
   * work correctly; `ScheduledPostPublisher` orders the chain as well, but that
   * is for liveness, not for safety. Why a pre-check needs no transaction is in
   * `services/scheduledChain.ts`: `scheduled -> published` is one-way, so the
   * reading can only err toward waiting.
   *
   * Returns `null` when the post was not claimable — gone, not this owner's,
   * already published, or still behind its parent — leaving the caller to tell
   * those apart if it needs to.
   */
  async claimAndPublishScheduledPost(params: {
    postId: string;
    ownerId?: string;
  }): Promise<IPost | null> {
    const pending = await Post.findById(params.postId).select('parentPostId').lean<{
      parentPostId?: string | null;
    }>();
    if (!pending) {
      return null;
    }
    if (!(await parentHasPublished(pending))) {
      return null;
    }

    const claimed = await Post.findOneAndUpdate(
      {
        _id: params.postId,
        status: 'scheduled',
        ...(params.ownerId ? { oxyUserId: params.ownerId } : {}),
      },
      { $set: { status: 'published' } },
      { new: true },
    );
    if (!claimed) {
      return null;
    }
    return this.publishScheduledPost(claimed);
  }

  /**
   * Publish a post that was created with `status: 'scheduled'` once its
   * `scheduledFor` time has arrived. Flips the status to `published`, then runs
   * the SAME publish pipeline a fresh published post runs in `create()`:
   * collaborator invites, the MTN dual-write, notifications, the real-time feed
   * emit, and (deferred until every collaborator has resolved) federation.
   *
   * Reached only through {@link claimAndPublishScheduledPost}, which is what
   * guarantees one publish per post: this method flips the status on a document
   * it was HANDED, so calling it directly with a stale copy would run the whole
   * pipeline a second time. Every side effect is isolated so one stage's failure
   * never aborts the others; the caller further isolates each post so one post
   * never sinks the batch.
   */
  async publishScheduledPost(post: IPost): Promise<IPost> {
    post.status = 'published';
    await post.save();
    await recordRecentReplierForPost(post);

    // The post is only now visible to readers, so this is where its enrichment
    // belongs — `create()` deliberately skipped it while the post was scheduled.
    // The SAME entry point the immediate create and the federated backfill use.
    enrichIngestedPosts([post]);

    const ownerId = getOwnerId(post.authorship ?? []) ?? null;
    const hasPendingInvites = hasPendingCollabInvites(post.authorship ?? []);

    if (ownerId && hasPendingInvites) {
      await postCollaborationService.notifyPendingInvites(post, ownerId);
    }

    // MTN dual-write now — the signed record's authoritative timestamp is the
    // publish moment, not the (earlier) scheduling moment.
    await this.emitMtnRecord(post);

    // The federation username is resolved inside runPostSideEffects from the
    // authoritative owner id (and only when the post will actually federate) —
    // the SAME server-side path the immediate create uses — so there is no
    // separate resolution here. Federation stays deferred while any collaborator
    // invite is still pending (`skipFederation`), mirroring create(); the
    // eventual accept() federates the post.
    await this.runPostSideEffects(post, {
      oxyUserId: ownerId,
      skipFederation: hasPendingInvites,
    });

    return post;
  }

  /**
   * Resolve the username outbound ActivityPub federation needs to build the local
   * actor for a post's author.
   *
   * The federation decision must NOT depend on the request-scoped `req.user`
   * carrying a `username`: the Oxy auth middleware guards every `POST /posts` path
   * WITHOUT `loadUser:true`, so `req.user` is only `{ id }` and any caller-supplied
   * `senderUsername` is effectively always absent on the immediate create path.
   * The authoritative identity is the owner's `oxyUserId`, so when no non-empty
   * username was supplied we resolve it server-side through the service Oxy client
   * — the exact mechanism the scheduled-publish path previously used inline.
   *
   * Prefers a caller-supplied non-empty username (a cheap fast path that also
   * preserves callers/tests that pass one), otherwise makes ONE (SDK-cached)
   * lookup. Invoked only after the other federation gates pass, so the lookup
   * never runs for a post that would not federate anyway. Fail-soft: a resolve
   * miss returns undefined and federation is simply skipped (logged), never
   * throwing into the publish pipeline.
   */
  private async resolveFederationUsername(
    oxyUserId: string,
    provided: string | undefined,
  ): Promise<string | undefined> {
    const supplied = provided?.trim();
    if (supplied) return supplied;
    try {
      const owner = await getServiceOxyClient().getUserById(oxyUserId);
      const resolved = owner.username?.trim();
      return resolved ? resolved : undefined;
    } catch (error) {
      logger.warn('PostCreationService: failed to resolve federation username from oxyUserId', error);
      return undefined;
    }
  }

  /**
   * Run the publish-time side-effect pipeline for a post that is now live:
   * mention / reply / quote / boost / subscriber notifications, the real-time
   * feed socket emit, and outbound ActivityPub federation delivery.
   *
   * Reads everything it needs from the persisted `post` document (mentions,
   * parent/quote/boost refs, visibility, status) so it can be driven both by
   * `create()` (a fresh publish) and by `publishScheduledPost()` (a previously
   * scheduled post going live). Every stage is isolated — a failure in one never
   * aborts the others or surfaces to the caller.
   */
  private async runPostSideEffects(
    post: IPost,
    ctx: {
      oxyUserId: string | null;
      senderUsername?: string;
      skipSocketEmit?: boolean;
      skipFederation: boolean;
    },
  ): Promise<void> {
    const oxyUserId = ctx.oxyUserId;
    const mentions = post.mentions ?? [];
    const parentPostId = post.parentPostId ?? null;
    const quoteOf = post.quoteOf ?? null;
    const boostOf = post.boostOf ?? null;

    // Run all notification stages in parallel — they are independent
    const results = await Promise.allSettled([
      // Mention notifications
      (async () => {
        if (oxyUserId && mentions.length > 0) {
          const isReply = Boolean(parentPostId);
          await createMentionNotifications(
            mentions,
            String(post._id),
            oxyUserId,
            isReply ? 'reply' : 'post',
          );
        }
      })(),
      // Reply / quote / boost notifications
      (async () => {
        if (!oxyUserId) return;
        const idsToFetch = [parentPostId, quoteOf, boostOf].filter(
          (id): id is string => Boolean(id),
        );
        if (idsToFetch.length === 0) return;

        const relatedPosts = await Post.find({ _id: { $in: idsToFetch } })
          .select('oxyUserId authorship')
          .lean();
        const postsMap = new Map(relatedPosts.map((p) => [String(p._id), p]));

        if (parentPostId) {
          const parent = postsMap.get(String(parentPostId));
          if (parent) {
            await createPostAuthorNotifications(
              parent.authorship as import('@mention/shared-types').PostAuthorshipEntry[] | undefined,
              {
                actorId: oxyUserId,
                type: 'reply',
                entityId: String(post._id),
                entityType: 'reply',
              },
            );
          }
        }

        if (quoteOf) {
          const original = postsMap.get(String(quoteOf));
          if (original) {
            await createPostAuthorNotifications(
              original.authorship as import('@mention/shared-types').PostAuthorshipEntry[] | undefined,
              {
                actorId: oxyUserId,
                type: 'quote',
                entityId: String(original._id),
                entityType: 'post',
              },
            );
          }
        }

        if (boostOf) {
          const original = postsMap.get(String(boostOf));
          if (original) {
            await createPostAuthorNotifications(
              original.authorship as import('@mention/shared-types').PostAuthorshipEntry[] | undefined,
              {
                actorId: oxyUserId,
                type: 'boost',
                entityId: String(original._id),
                entityType: 'post',
              },
            );
          }
        }
      })(),
      // "Somebody I follow posted" — readers who subscribed to the AUTHOR
      // (`PostSubscription`). Top-level posts only.
      //
      // A channel needs nothing extra here: a channel is an Oxy account and
      // authors its own posts, so following a channel is an ordinary follow of
      // that account and its readers arrive through the same subscription rows as
      // anyone else's. The `ChannelFollow` fan-out this stage used to also walk
      // existed only because a channel post was authored by a PERSON and could
      // therefore never reach its own readers.
      (async () => {
        const isTopLevelPost = !parentPostId;
        if (!oxyUserId || !isTopLevelPost) return;

        const recipientIds = new Set<string>();

        const subs = await PostSubscription.find({ authorId: oxyUserId }).lean();
        for (const sub of subs) {
          if (sub.subscriberId) recipientIds.add(String(sub.subscriberId));
        }

        // The author never notifies themselves. `createNotification` refuses that
        // too, but dropping it here keeps the batch honest about its own size.
        recipientIds.delete(oxyUserId);
        if (recipientIds.size === 0) return;

        await createBatchNotifications(
          [...recipientIds].map((recipientId) => ({
            recipientId,
            actorId: oxyUserId,
            type: 'post' as const,
            entityId: String(post._id),
            entityType: 'post' as const,
          })),
          true,
        );
      })(),
    ]);

    for (const r of results) {
      if (r.status === 'rejected') {
        logger.error('PostCreationService: notification stage failed', r.reason);
      }
    }

    const isPublished = (post.status ?? 'published') === 'published';

    const shouldEmitGlobally = post.visibility === 'public' && isPublished;
    if (!ctx.skipSocketEmit && shouldEmitGlobally) {
      try {
        const io = getRuntimeSocketServer();
        if (io) {
          // Emit the canonical hydrated DTO (author summary, resolved
          // name.displayName, engagement shape, and embedded boosted original)
          // so the post renders correctly in real time instead of as a raw,
          // unhydrated document. Mirrors createThread's post-create emit.
          // maxDepth:1 is REQUIRED so a created boost embeds its boostOf target
          // (a boost has an intentionally empty body and renders blank otherwise).
          const [hydratedPost] = await postHydrationService.hydratePosts([post.toObject()], {
            // This DTO is broadcast to all sockets, so hydrate as an anonymous
            // viewer. Nested quote/boost references that are not publicly
            // visible are omitted instead of leaking via a creator-specific ACL.
            viewerId: undefined,
            oxyClient: getServiceOxyClient(),
            maxDepth: 1,
            includeLinkMetadata: true,
          });
          if (hydratedPost) {
            io.emit('feed:updated', {
              type: 'for_you',
              post: hydratedPost,
              timestamp: new Date().toISOString(),
            });
            io.emit('feed:updated', {
              type: 'following',
              post: hydratedPost,
              authorId: oxyUserId,
              timestamp: new Date().toISOString(),
            });
          }
        }
      } catch (socketError) {
        logger.warn('PostCreationService: failed to emit socket event', socketError);
      }
    }

    // Federation is published-only: a draft never fans out even if a username is
    // resolvable, and the collab-pending gate is honored via `ctx.skipFederation`.
    // The federation username is resolved server-side from the authoritative owner
    // id (only after these gates pass), so the fan-out no longer depends on the
    // SDK having populated `req.user.username` — which it never does, because the
    // auth middleware runs without `loadUser:true` on every `POST /posts` path.
    if (!ctx.skipFederation && isPublished && oxyUserId) {
      const federationUsername = await this.resolveFederationUsername(oxyUserId, ctx.senderUsername);
      if (federationUsername) {
        try {
          // Late-bound accessor avoids a circular import with the connector registry.
          await getPostFederator().federateNewPost(post, oxyUserId, federationUsername);
          post.metadata = { ...(post.metadata ?? {}), federationDelivered: true };
          post.markModified('metadata');
          await post.save();
        } catch (fedError) {
          logger.error('PostCreationService: failed to federate post', fedError);
        }
      }
    }
  }
}

export const postCreationService = new PostCreationService();
// Register with the late-bound service registry so the network connectors can
// create posts from federated notes/boosts without a circular import. See
// serviceRegistry.ts.
registerPostCreator(postCreationService);
