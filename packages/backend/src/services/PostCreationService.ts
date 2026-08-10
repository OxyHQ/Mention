import { eq } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { postSubscriptions } from '../db/schema/engagement';
import { posts } from '../db/schema/posts';
import {
  claimScheduledPost,
  insertPostRecord,
  loadPostRecord,
  loadPostRecords,
  updatePostRecord,
} from '../db/posts/postRepository';
import {
  POST_CLASSIFICATION_PENDING,
  type PostRecord,
  type PostRecordClassification,
  type PostRecordFederation,
  type PostRecordInput,
} from '../db/posts/postRecord';
import {
  PostType,
  PostVisibility,
  PostContent,
  MediaItem,
  PostMetadata,
  ReplyPermission,
} from '@mention/shared-types';
import {
  mentionTextsFromContent,
} from '@mention/shared-types/mentions';
import { reconcileMentionIdsForPost } from '../utils/textProcessing';
import { foldProfileLinkMentions } from './profileLinkMentions';
import {
  createMentionNotifications,
  createBatchNotifications,
  createPostAuthorNotifications,
} from '../utils/notificationUtils';
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
import { authorVariants, declaredBaseLanguages, toStoredContent } from './postVariants';
import { recordRecentReplierForPost } from './PostRecentReplierService';
import { parentHasPublished } from './scheduledChain';
import { assertLaneAssignable } from '../utils/laneAssignment';
import {
  assertAnswersOperatedAccount,
  assertContinuesOwnThread,
} from '../utils/threadContinuation';
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
   * Publish this post AS another Oxy account the caller operates: a `channel`,
   * or an organization / project / bot they may act as.
   *
   * The post is AUTHORED BY that account: it carries the account's `oxyUserId`
   * and its `authorship`, so it lands on that account's profile and in the
   * timelines of its followers, and it renders with its avatar and name. The
   * authenticated human moves to `writtenByOxyUserId`, OUTSIDE `authorship` —
   * putting them inside would both break the channel's anonymity and put the post
   * back on their own profile.
   *
   * Validated by {@link assertCanPublishAsAccount} before the document is built:
   * an account the caller is not an accepted member of is a 403, and so is an
   * act-as-eligible account they hold no `account:act_as` over. Publishing as a
   * CHANNEL additionally forces `replyPermission: ['nobody']`; publishing as an
   * organization does not — see there.
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
  /**
   * This post CONTINUES a thread its own author started — the single case in
   * which a post carrying both {@link publishAsOxyUserId} and `parentPostId` is
   * not a reply in the sense the refusal below is about. A thread is one text in
   * several parts; a post answering itself is not a conversation.
   *
   * **It grants nothing on its own.** Setting it only asks for
   * {@link assertContinuesOwnThread} to be consulted, and that reads the parent
   * and the thread root back out of the database to confirm both are authored by
   * the SAME account this post will be. A caller that lies is refused by exactly
   * the same 400 it would have got for a plain reply.
   *
   * **Never read from a request body.** `POST /posts` builds its params from an
   * explicit whitelist and does not name this field, so the exception is reachable
   * only from `POST /posts/thread`, where the parent of every continuation is a
   * post THIS SAME REQUEST just created. Adding it to a body whitelist would turn
   * a structural property into a client claim — see `utils/threadContinuation` for
   * why the wider "may act for the parent's account" rule is not the same thing.
   */
  continuesOwnThread?: boolean;
  /**
   * This post ANSWERS another account, in a thread the same request is composing
   * whose entries carry different accounts — the second, separate exception.
   *
   * Distinct from {@link continuesOwnThread} rather than a looser setting of it,
   * because the two authorize opposite shapes: that one says "one account, its
   * own text"; this one says "two accounts the caller operates, talking". A
   * CHANNEL may use only the first — a channel in a conversation is the thing
   * `utils/channelReplyGate` refuses at five write sites, with no exception for
   * its own operators — so {@link assertAnswersOperatedAccount} refuses a channel
   * at BOTH ends of the link, reading both kinds from the account graph.
   *
   * Grants nothing on its own, and never read from a request body, for the same
   * reasons as {@link continuesOwnThread}.
   */
  answersOperatedAccount?: boolean;
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
  metadata?: PostMetadata;
  // Federation fields — only for incoming federated posts
  federation?: PostRecordFederation;
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

/**
 * Account subscriptions are an opt-in to PUBLIC publication announcements,
 * not permission to read an author's unpublished or restricted posts.
 */
export function isSubscriberNotificationEligible(
  post: Pick<PostRecord, 'status' | 'visibility'>,
): boolean {
  return post.status === 'published' && post.visibility === PostVisibility.PUBLIC;
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

/**
 * The Stage-A classification a post is stored with, plus the primary language it
 * resolved.
 *
 * Returned rather than written into a mutable bag: `PostRecordInput` is a typed
 * literal now, so a stray key is a `tsc` error instead of a column that never
 * gets written — and the language has to reach BOTH the row's `language` column
 * and the primary variant's tag, which a single mutation site cannot express
 * without the caller re-reading its own scratch object.
 *
 * That catches a stray key and NOT a missing one, which is the direction that has
 * actually bitten: a column absent from `PostRecordInput` is silently never
 * written, whatever this service passes. See the note on that type.
 */
interface BaselineClassification {
  postClassification?: Partial<PostRecordClassification>;
  language?: string;
}

class PostCreationService {
  /**
   * Compute the deterministic Stage-A classification for a post, keeping
   * `status: 'pending'` so the async AI batch (PostClassificationService) still
   * enriches the post afterward.
   *
   * Best-effort and non-fatal: classification MUST NEVER block or fail post
   * creation. The classifier is pure/synchronous so it should not throw, but any
   * throw is caught + logged at warn and the post is still stored with the
   * column defaults (`status: 'pending'`, zeroed scores) untouched.
   */
  private baselineClassification(
    params: CreatePostParams,
    primaryText: string,
  ): BaselineClassification {
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
      // key is configured (the intended hybrid). The classification carries ONLY
      // the multi-language `languages` array — there is no single-value field.
      return {
        postClassification: {
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
        },
        // Keep the top-level AP `post.language` (single, protocol-facing) in
        // sync with the resolved primary (`languages[0]`, already normalized to
        // ISO 639-1). When the classifier could not resolve any language, the
        // caller's own `params.language` (if any) is left untouched.
        language: signals.languages[0],
      };
    } catch (error) {
      // Never block creation on classification — fall back to the column
      // defaults (`status: 'pending'`) so the AI batch still processes the post.
      logger.warn('PostCreationService: baseline classification failed; saving without Stage-A signals', error);
      return {};
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
  private async emitMtnRecord(post: PostRecord): Promise<void> {
    try {
      if (post.federation != null || !post.oxyUserId) {
        return;
      }

      if (post.boostOf) {
        const original = await loadPostRecord(post.boostOf);
        await emitRepostCreated(post, post.boostOf, original?.oxyUserId ?? undefined);
        return;
      }

      let reply: ReplyContext | undefined;
      if (post.parentPostId) {
        const rootId = post.threadId ?? post.parentPostId;
        const ids = [...new Set([post.parentPostId, rootId])];
        const refs = await loadPostRecords(ids);
        const ownerById = new Map(refs.map((r) => [r.id, r.oxyUserId]));
        const parentOwner = ownerById.get(post.parentPostId);
        const rootOwner = ownerById.get(rootId);
        if (parentOwner && rootOwner) {
          reply = {
            root: { postId: rootId, oxyUserId: rootOwner },
            parent: { postId: post.parentPostId, oxyUserId: parentOwner },
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
  async create(params: CreatePostParams): Promise<PostRecord> {
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
    // published as the account.
    //
    // The reply refusal is deliberately kept for the act-as-eligible kinds too,
    // where the channel argument does not apply: replying AS an organization is a
    // coherent feature, but it is a feature — nothing asks for it, and admitting
    // it here by omission would ship it unconsidered and untested.
    //
    // TWO EXCEPTIONS, and neither is "the author may act for the parent's
    // account". A thread is joined by `parentPostId`, so every entry after the
    // first is structurally a reply; whether it is a CONVERSATION depends on
    // whose accounts are at the two ends, which is what the two checks decide:
    //
    //   - `continuesOwnThread` — one account, its own text. Verified: parent and
    //     thread root both authored by the account this post will be.
    //   - `answersOperatedAccount` — two accounts the caller operates, talking.
    //     Verified: neither end is a CHANNEL, and the caller may act for the
    //     parent's account too.
    //
    // Both are VERIFIED below rather than asserted, and a channel may only ever
    // use the first — see `utils/threadContinuation` for why the wider rule would
    // reopen a channel's replies to its own operators, which cannot happen.
    if (params.publishAsOxyUserId) {
      if (params.parentPostId && !params.continuesOwnThread && !params.answersOperatedAccount) {
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
    const { authorId, authorKind } = await assertCanPublishAsAccount({
      publishAsOxyUserId: params.publishAsOxyUserId,
      callerId: params.oxyUserId,
      memberReader: params.memberReader,
    });
    const publishedAsAccount = authorId !== null && authorId !== params.oxyUserId;

    // The continuation claim is verified AFTER the publish-as gate, because what
    // it has to prove is about the RESOLVED author — the account the post will
    // actually carry — and that is not known until the gate has answered. Still
    // before anything is written, like every other refusal here.
    if (params.publishAsOxyUserId && params.parentPostId) {
      if (params.continuesOwnThread) {
        await assertContinuesOwnThread({
          parentPostId: params.parentPostId,
          threadId: params.threadId,
          authorId,
        });
      } else if (params.answersOperatedAccount) {
        // `authorKind` is handed over rather than re-resolved: it is the kind the
        // gate just decided this post's identity on, so the channel test and the
        // authorization cannot end up disagreeing about what this account is.
        await assertAnswersOperatedAccount({
          parentPostId: params.parentPostId,
          threadId: params.threadId,
          authorId,
          authorKind,
          callerId: params.oxyUserId,
          memberReader: params.memberReader,
        });
      }
    }

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
    // is the PRIMARY guard on the ingest paths, so a federated Note that reaches
    // `create` must never persist an empty body: no text, no media, no
    // attachments, no poll, and no content-warning summary is a blank post with
    // nothing to render. Reject it loudly rather than store a ghost. Native
    // (non-federated) posts are unaffected — this only guards the federated branch.
    //
    // A BOOST is exempt, and the exemption is load-bearing rather than a
    // loophole. A `type:'boost'` post carries an intentionally empty body and
    // renders entirely from `boostOf` — that is the same shape a native repost
    // stores. Without this clause the guard matched every inbound Announce:
    // `importAnnounce` builds exactly `{ content: { text: '' }, boostOf,
    // federation }`, the throw was swallowed by that method's `catch` into a
    // `logger.warn`, and it returned `false`. The visible result was that NO
    // federated boost has ever imported — no boost row, `stats.boostsCount` and
    // `stats.federatedBoostsCount` never moving — with nothing above WARN to say
    // so. The same creator serves the outbox-backfill boost path, so both were
    // affected.
    //
    // `boostOf` cannot dangle: it carries a foreign key to `posts.id`, and
    // `importAnnounce` verifies the original is published and public first, so
    // "has a boostOf" really does mean "has something to render".
    if (params.federation != null && params.boostOf == null) {
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

    // Stage-A deterministic classification (native + single-federated paths).
    // Best-effort: keeps `status: 'pending'` so the AI batch still enriches it.
    // It runs BEFORE the content is built because the language it resolves is what
    // tags the primary variant when the author declared none. The classifier's
    // resolution WINS over the caller's `params.language` — it has already
    // normalized the tag to ISO 639-1 — and falls back to the caller's when it
    // resolved nothing at all.
    const baseline = this.baselineClassification(params, primaryText);
    const primaryLanguage = baseline.language ?? params.language;

    const storedContent = toStoredContent(content, primaryLanguage);

    // A profile link the author pasted is a mention, and THIS is where it becomes
    // one: the URL is rewritten into the same `[mention:<id>]` placeholder the
    // composer's picker produces, and the id it names is authorized alongside the
    // ones the picker sent. See `foldProfileLinkMentions` for the whole argument
    // — the short version is that the federated ingest has always done exactly
    // this to exactly these URLs, so a post composed here was the odd one out.
    //
    // Skipped for a federated ingest, whose body already went through that same
    // lookup against the same stored identities on the way in, on the HTML it
    // arrived as. Re-asking here could only spend the lookups a second time for
    // the same answers.
    //
    // `storedContent` is rewritten IN PLACE by the fold, so it must run before
    // the record input reads it.
    const authorizedMentions = params.federation != null
      ? params.mentions
      : (await foldProfileLinkMentions(storedContent, params.mentions)).mentions;

    // Collaborators defer federation: an invitee must never be leaked to the
    // fediverse before consenting, so the flag is set at INSERT rather than
    // patched afterwards — a post that federated between the two writes could
    // not be un-federated.
    const collaboratorIds = params.collaboratorIds ?? [];
    const deferCollabFederation = authorId != null && collaboratorIds.length > 0;

    const input: PostRecordInput = {
      oxyUserId: authorId,
      authorship: authorId != null
        ? postCollaborationService.buildAuthorship(authorId, collaboratorIds)
        : [],
      // The human behind a channel post — recorded OUTSIDE `authorship`, which is
      // what keeps the post off their own profile and their name out of the
      // byline. Set only when the author is somebody else, so an ordinary post
      // never duplicates its own author here.
      writtenByOxyUserId: publishedAsAccount ? params.oxyUserId : null,
      type: derivePostType({ ...params, content }),
      visibility: params.visibility ?? PostVisibility.PUBLIC,
      status: params.status ?? 'published',
      hashtags: params.hashtags ?? [],
      reviewReplies: params.reviewReplies ?? false,
      quotesDisabled: params.quotesDisabled ?? false,
      quoteOf: params.quoteOf ?? null,
      boostOf: params.boostOf ?? null,
      parentPostId: params.parentPostId ?? null,
      threadId: params.threadId ?? null,
      // A CHANNEL post is persisted with `['nobody']` whatever the caller asked
      // for — DEFENCE IN DEPTH, and it buys the client's existing reply-button
      // suppression with no new UI. It is NOT what the server's refusal rests on:
      // `utils/channelReplyGate` reads the AUTHOR's account kind, because this
      // field is mutable and a later settings write must not be able to reopen
      // the post.
      //
      // Keyed on the author's KIND, not on "was this published as somebody else":
      // "no replies, ever" is a property of channels, not of publishing as an
      // account. An organization/project/bot post is an ORDINARY post — the reply
      // gate lets replies through for a non-channel author, so forcing `['nobody']`
      // here would leave the persisted field and the server's own rule disagreeing,
      // and would silently close every organization's comments.
      replyPermission: (authorKind === 'channel'
        ? ['nobody']
        : params.replyPermission ?? ['anyone']) as ReplyPermission[],
      laneId: params.laneId ?? null,
      content: storedContent,
      // Reconciled from the FINALIZED stored bodies. Incoming metadata alone must
      // never create a notification recipient.
      mentions: reconcileMentionIdsForPost(
        mentionTextsFromContent(storedContent),
        authorizedMentions,
      ),
      metadata: {
        ...(params.metadata ?? {}),
        ...(deferCollabFederation ? { collabFederationDeferred: true } : {}),
      },
      ...(params.federation != null ? { federation: params.federation } : {}),
      ...(params.location != null ? { location: params.location } : {}),
      ...(primaryLanguage != null ? { language: primaryLanguage } : {}),
      ...(params.scheduledFor != null ? { scheduledFor: params.scheduledFor } : {}),
      ...(baseline.postClassification ? { postClassification: baseline.postClassification } : {}),
      ...(params.createdAt != null ? { createdAt: params.createdAt } : {}),
      ...(params.updatedAt != null ? { updatedAt: params.updatedAt } : {}),
    };

    // `lane_id` goes in as an ordinary nullable value. Mongo had to set it
    // ONLY when present, because `post_lane_chrono_v1`'s partial filter is
    // `{ laneId: { $exists: true } }` and a stored `null` satisfies it —
    // indexing every post in the collection and defeating the partial index.
    // The Postgres partial index is `where lane_id is not null`, so NULL is the
    // state that stays out of it, and "absent" and "null" are one state rather
    // than two that can disagree.
    let post = await insertPostRecord(input);
    await recordRecentReplierForPost(post);

    const isPublished = post.status === 'published';

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
      post = await postCollaborationService.autoAcceptInvites(
        post,
        new Set(params.autoAcceptCollaboratorIds),
      );
    }

    const hasPendingInvites = hasPendingCollabInvites(post.authorship);

    if (isPublished && hasPendingInvites && authorId) {
      await postCollaborationService.notifyPendingInvites(post, authorId);
    }

    const skipFederation =
      params.skipFederationDelivery ||
      hasPendingInvites ||
      post.metadata.federationDelivered === true;

    // MTN Protocol dual-write (best-effort, never blocks, never changes output).
    // Postgres is authoritative; this emits a signed `app.mention.feed.*` record
    // for LOCAL authors only (`federation == null && oxyUserId`). A scheduled
    // post is not yet published, so it emits when the scheduler publishes it.
    if (!isScheduled) {
      await this.emitMtnRecord(post);
    }

    if (isScheduled || params.skipNotifications) {
      return post;
    }

    return this.runPostSideEffects(post, {
      oxyUserId: authorId,
      senderUsername: params.senderUsername,
      skipSocketEmit: params.skipSocketEmit,
      skipFederation,
    });
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
   * The conditional UPDATE in {@link claimScheduledPost} is the mutual exclusion
   * — see its docblock for why one statement is enough. `publishScheduledPost`
   * then re-sets the status it already holds, which is a no-op, and runs the side
   * effects exactly once.
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
  }): Promise<PostRecord | null> {
    const [pending] = await getDb()
      .select({ parentPostId: posts.parentPostId })
      .from(posts)
      .where(eq(posts.id, params.postId))
      .limit(1);
    if (!pending) {
      return null;
    }
    if (!(await parentHasPublished(pending))) {
      return null;
    }

    const claimed = await claimScheduledPost(params.postId, params.ownerId);
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
  async publishScheduledPost(post: PostRecord): Promise<PostRecord> {
    await updatePostRecord(post.id, { status: 'published' });
    const published: PostRecord = { ...post, status: 'published' };
    await recordRecentReplierForPost(published);

    // The post is only now visible to readers, so this is where its enrichment
    // belongs — `create()` deliberately skipped it while the post was scheduled.
    // The SAME entry point the immediate create and the federated backfill use.
    enrichIngestedPosts([published]);

    const ownerId = getOwnerId(published.authorship) ?? null;
    const hasPendingInvites = hasPendingCollabInvites(published.authorship);

    if (ownerId && hasPendingInvites) {
      await postCollaborationService.notifyPendingInvites(published, ownerId);
    }

    // MTN dual-write now — the signed record's authoritative timestamp is the
    // publish moment, not the (earlier) scheduling moment.
    await this.emitMtnRecord(published);

    // The federation username is resolved inside runPostSideEffects from the
    // authoritative owner id (and only when the post will actually federate) —
    // the SAME server-side path the immediate create uses — so there is no
    // separate resolution here. Federation stays deferred while any collaborator
    // invite is still pending (`skipFederation`), mirroring create(); the
    // eventual accept() federates the post.
    return this.runPostSideEffects(published, {
      oxyUserId: ownerId,
      skipFederation: hasPendingInvites,
    });
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
   * Reads everything it needs from the persisted `post` record (mentions,
   * parent/quote/boost refs, visibility, status) so it can be driven both by
   * `create()` (a fresh publish) and by `publishScheduledPost()` (a previously
   * scheduled post going live). Every stage is isolated — a failure in one never
   * aborts the others or surfaces to the caller.
   *
   * Returns the post as it now stands: a successful fan-out sets
   * `metadata.federationDelivered`, and the record is a plain object rather than
   * a live document, so the caller's copy would otherwise still say `false` —
   * which is the flag `maybeFederateOnResolve` reads to decide whether a later
   * invite resolution should federate the post a SECOND time.
   */
  private async runPostSideEffects(
    post: PostRecord,
    ctx: {
      oxyUserId: string | null;
      senderUsername?: string;
      skipSocketEmit?: boolean;
      skipFederation: boolean;
    },
  ): Promise<PostRecord> {
    const oxyUserId = ctx.oxyUserId;
    const mentions = post.mentions;
    const parentPostId = post.parentPostId;
    const quoteOf = post.quoteOf;
    const boostOf = post.boostOf;

    // Run all notification stages in parallel — they are independent
    const results = await Promise.allSettled([
      // Mention notifications
      (async () => {
        if (oxyUserId && mentions.length > 0) {
          const isReply = Boolean(parentPostId);
          await createMentionNotifications(
            mentions,
            post.id,
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

        const relatedPosts = await loadPostRecords(idsToFetch);
        const postsMap = new Map(relatedPosts.map((p) => [p.id, p]));

        if (parentPostId) {
          const parent = postsMap.get(parentPostId);
          if (parent) {
            await createPostAuthorNotifications(parent.authorship, {
              actorId: oxyUserId,
              type: 'reply',
              entityId: post.id,
              entityType: 'reply',
            });
          }
        }

        if (quoteOf) {
          const original = postsMap.get(quoteOf);
          if (original) {
            await createPostAuthorNotifications(original.authorship, {
              actorId: oxyUserId,
              type: 'quote',
              entityId: original.id,
              entityType: 'post',
            });
          }
        }

        if (boostOf) {
          const original = postsMap.get(boostOf);
          if (original) {
            await createPostAuthorNotifications(original.authorship, {
              actorId: oxyUserId,
              type: 'boost',
              entityId: original.id,
              entityType: 'post',
            });
          }
        }
      })(),
      // "Somebody I follow posted" — readers who subscribed to the AUTHOR
      // (`PostSubscription`). Top-level posts only.
      //
      // A channel needs nothing extra here: a channel is an Oxy account and
      // authors its own posts, so following a channel is an ordinary follow of
      // that account and its readers arrive through the same subscription rows as
      // anyone else's.
      (async () => {
        const isTopLevelPost = !parentPostId;
        if (
          !oxyUserId ||
          !isTopLevelPost ||
          !isSubscriberNotificationEligible(post)
        ) {
          return;
        }
        // Subscribers of the AUTHOR, plus — for a channel post — everyone who
        // follows the channel with `notify`.
        const recipientIds = new Set<string>();

        // Postgres: nothing has written the Mongo collection since post
        // subscriptions moved, so this fan-out had stopped finding subscribers
        // and new-post notifications quietly stopped being sent to anyone who
        // subscribed after the cutover.
        const subs = await getDb()
          .select({ subscriberId: postSubscriptions.subscriberId })
          .from(postSubscriptions)
          .where(eq(postSubscriptions.authorId, oxyUserId));
        for (const sub of subs) recipientIds.add(sub.subscriberId);

        // The author never notifies themselves. `createNotification` refuses that
        // too, but dropping it here keeps the batch honest about its own size.
        recipientIds.delete(oxyUserId);
        if (recipientIds.size === 0) return;

        const notifications = [...recipientIds]
          .map((recipientId) => ({
            recipientId,
            actorId: oxyUserId,
            type: 'post' as const,
            entityId: post.id,
            entityType: 'post' as const,
          }));
        if (notifications.length > 0) {
          await createBatchNotifications(notifications, true);
        }
      })(),
    ]);

    for (const r of results) {
      if (r.status === 'rejected') {
        logger.error('PostCreationService: notification stage failed', r.reason);
      }
    }

    const isPublished = post.status === 'published';

    const shouldEmitGlobally = post.visibility === PostVisibility.PUBLIC && isPublished;
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
          const [hydratedPost] = await postHydrationService.hydratePosts([post], {
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
    if (!ctx.skipFederation) {
      const delivered = await this.federatePublishedPost(post, {
        oxyUserId,
        senderUsername: ctx.senderUsername,
      });
      if (delivered) return delivered;
    }

    return post;
  }

  /**
   * Deliver ONE published local post outbound, and stamp it as delivered.
   *
   * The single implementation of "federate this post", shared by the publish
   * pipeline above and by the batch path (`connectors/threadFederation.ts`),
   * which federates a thread/beast batch after `createThread` has written every
   * row. Two implementations of this would drift on exactly the gates that
   * matter — published-only, a resolvable username, the delivered stamp — so
   * there is one, and callers differ only in WHEN they call it.
   *
   * The federation username is resolved server-side from the authoritative owner
   * id, and only after the gates pass, so the fan-out never depends on the SDK
   * having populated `req.user.username` — which it never does, because the auth
   * middleware runs without `loadUser:true` on every `POST /posts` path.
   *
   * `alsoDeliverToAudiencesOf` names OTHER local accounts whose remote followers
   * should also receive this activity. It is only ever set for a cross-account
   * thread; see the note on it in `connectors/threadFederation.ts` for what it
   * does and does not buy.
   *
   * Returns the post as it now stands, carrying `federationDelivered` — or
   * `null` when it was not handed to the connectors. A `PostRecord` is an
   * immutable value rather than a live document, so "was it delivered" and "the
   * row as it now reads" are ONE answer here instead of a boolean beside a
   * document the caller has to remember was mutated in place. The batch path
   * reads the `null` to stop a chain at the first link that did not go out.
   * Never throws: a delivery failure is logged and reported as `null`.
   */
  async federatePublishedPost(
    post: PostRecord,
    ctx: {
      oxyUserId: string | null;
      senderUsername?: string;
      alsoDeliverToAudiencesOf?: string[];
    },
  ): Promise<PostRecord | null> {
    if (post.status !== 'published' || !ctx.oxyUserId) return null;

    const federationUsername = await this.resolveFederationUsername(
      ctx.oxyUserId,
      ctx.senderUsername,
    );
    if (!federationUsername) return null;

    try {
      // Late-bound accessor avoids a circular import with the connector registry.
      await getPostFederator().federateNewPost(
        post,
        ctx.oxyUserId,
        federationUsername,
        ctx.alsoDeliverToAudiencesOf,
      );
      await updatePostRecord(post.id, { metadata: { federationDelivered: true } });
      return { ...post, metadata: { ...post.metadata, federationDelivered: true } };
    } catch (fedError) {
      logger.error('PostCreationService: failed to federate post', fedError);
      return null;
    }
  }
}

export const postCreationService = new PostCreationService();
// Register with the late-bound service registry so the network connectors can
// create posts from federated notes/boosts without a circular import. See
// serviceRegistry.ts.
registerPostCreator(postCreationService);
