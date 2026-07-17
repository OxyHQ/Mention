import mongoose from 'mongoose';
import { createInboundDispatcher } from '@oxyhq/federation/node';
import { logger } from '../../utils/logger';
import FederatedActor from '../../models/FederatedActor';
import FederatedFollow from '../../models/FederatedFollow';
import { Post } from '../../models/Post';
import Like from '../../models/Like';
import {
  FEDERATION_MAX_CONTENT_LENGTH,
  resolveOxyUser,
} from './constants';
import { PostType } from '@mention/shared-types';
import type { PostAuthorshipEntry } from '@mention/shared-types';
import { extractApLanguage, extractApLanguages } from './apLanguage';
import { getPostCreator } from '../../services/serviceRegistry';
import { pollVoteService } from '../../services/PollVoteService';
import { isFediverseSharingEnabled, isFediverseSharingEnabledFromUser } from '../../services/fediverseSharing';
import { actorService } from './actor.service';
import { requireActorOxyUserId } from '../shared/ActorResolutionPendingError';
import { outboxSyncService } from './outbox.service';
import { deliveryService } from './delivery.service';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import {
  extractAnnouncedObjectUri,
  extractApQuoteUri,
  extractInReplyToUri,
  isDuplicateKeyError,
  mapApVisibility,
  parseApPublished,
  resolvePostIdFromObjectUri,
} from './helpers';
import { buildFederatedNoteContent, buildFederatedNoteContentForEdit } from './apPostContent';
import { applyMentionPlaceholders, resolveInboundMentions } from './apMentions';
import { normalizeMentionIds } from '../../utils/textProcessing';
import { getRemoteHost } from '../shared/url';
import { parseInboundActivity, parseNote, primaryApType } from './apSchemas';
import type { z } from 'zod';

/**
 * Compact, log-safe summary of a `ZodError` — the first few issues rendered as
 * `path: message`, capped so a hostile payload can't blow up a log line. Used to
 * explain why an inbound activity was dropped without dumping the raw error tree.
 */
function summarizeZodError(error: z.ZodError): string {
  const MAX_ISSUES = 3;
  const parts = error.issues.slice(0, MAX_ISSUES).map((issue) => {
    const at = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${at}: ${issue.message}`;
  });
  if (error.issues.length > MAX_ISSUES) {
    parts.push(`(+${error.issues.length - MAX_ISSUES} more)`);
  }
  return parts.join('; ');
}

/**
 * The CONTENT handlers for inbound ActivityPub activities (Create / Delete / Like
 * / Announce / Update, and a non-follow Undo) delivered to a local user's inbox.
 *
 * The protocol DISPATCH + the follow lifecycle (Follow / Accept / Undo(Follow) /
 * Reject) now live in `@oxyhq/federation`'s inbound dispatcher (`inboundDispatcher`,
 * wired at the bottom of this module) — it validates the untrusted activity, bridges
 * the Oxy follow edge (via the identity adapter → {@link bridgeFollowEdge}), and
 * hands every CONTENT verb to {@link InboxProcessingService.onContentActivity}. This
 * class owns only the content: post ingest, engagement, and the fan-out of native
 * notifications. Depends on ActorService (actor resolution + actor→Oxy id),
 * OutboxSyncService (boost import), the shared low-level helpers, and the registered
 * PostCreator. None of those import this module, so the direct imports are cycle-free.
 */
export class InboxProcessingService {
  /**
   * Process one already-actor-verified inbound activity by delegating to the shared
   * engine dispatcher. Kept as an instance method so the BullMQ worker + the
   * connector facade keep calling `inboxProcessingService.processInboxActivity`.
   */
  processInboxActivity(activity: Record<string, any>, verifiedActorUri: string): Promise<void> {
    return inboundDispatcher.processInboxActivity(activity, verifiedActorUri);
  }

  /**
   * Handle a CONTENT activity the engine does not own — Create / Delete / Like /
   * Announce / Update, and a non-follow Undo (Undo(Like) / Undo(Announce)). The
   * engine has already verified the actor + validated the activity; this re-reads
   * the primary type and routes to the matching content handler, so the handlers'
   * side effects stay byte-for-byte identical to the prior single-dispatch path.
   */
  async onContentActivity(activity: Record<string, any>, verifiedActorUri: string): Promise<void> {
    const type = primaryApType(activity.type);
    switch (type) {
      case 'Create':
        await this.handleCreate(activity, verifiedActorUri);
        break;
      case 'Delete':
        await this.handleDelete(activity, verifiedActorUri);
        break;
      case 'Like':
        await this.handleLike(activity, verifiedActorUri);
        break;
      case 'Announce':
        await this.handleAnnounce(activity, verifiedActorUri);
        break;
      case 'Update':
        await this.handleUpdate(activity, verifiedActorUri);
        break;
      case 'Undo':
        await this.handleUndoContent(activity.object, verifiedActorUri);
        break;
      default:
        logger.debug(`Unhandled content activity type: ${type}`);
    }
  }

  /**
   * Dispatch the content half of an inbound `Undo` — the engine routes a non-follow
   * Undo here (an Undo(Follow) is handled by the engine itself). A `Like` teardown
   * deletes the native `Like` doc; an `Announce` teardown deletes the native boost
   * `Post`. Both are ungated (an Undo is teardown, not new engagement) — see the
   * handler doc comments.
   */
  private async handleUndoContent(object: any, actorUri: string): Promise<void> {
    const objectType = typeof object === 'string' ? null : object?.type;
    if (objectType === 'Like') {
      await this.handleUndoLike(object, actorUri);
    } else if (objectType === 'Announce') {
      await this.handleUndoAnnounce(object, actorUri);
    }
  }

  /**
   * Whether the LOCAL owner of `postId` currently allows fediverse sharing.
   * Returns `true` (proceed) when the post can't be found, is remote-owned/
   * mirrored (`federation != null`), or has no local `oxyUserId` — gating
   * only ever applies to a real local owner, never a mirrored federated post.
   * Id-based (redis-cached, fails OPEN on an Oxy outage — correct for
   * inbound activities, same as every other consent read on this path).
   *
   * Shared by every shared-inbox handler below that creates NEW engagement
   * against an EXISTING post (a reply's parent, a Like target, an Announce
   * target) so an opted-out user's content stops accruing engagement the
   * moment sharing is off — mirroring {@link handleIncomingFollow}'s gate for
   * the Follow case. Deliberately NOT used by the Undo variants
   * (`handleUndoLike`, `handleUndoAnnounce`) — see their own doc comments:
   * an Undo is teardown, not new engagement, and must always converge.
   */
  private async isLocalPostOwnerSharingEnabled(postId: string): Promise<boolean> {
    const post = await Post.findOne(
      { _id: postId },
      { oxyUserId: 1, federation: 1 },
    ).lean<{ oxyUserId?: string | null; federation?: unknown } | null>();
    if (!post || post.federation != null || !post.oxyUserId) return true;
    return isFediverseSharingEnabled(post.oxyUserId);
  }

  /**
   * Best-effort: notify the LOCAL owner (+ accepted collaborators) of `postId`
   * about a NEW inbound federated engagement, mirroring the NATIVE
   * like/boost/reply notification (`createPostAuthorNotifications` — the SAME
   * util the local `posts.controller` like path and `PostCreationService`
   * reply/boost path call) so a Mastodon like/boost/reply on a Mention post
   * reaches the owner's notifications exactly like the local equivalent.
   *
   * No-op when the post is gone or REMOTE-owned/mirrored (`federation != null`):
   * a mirrored post's "owner" is a federated actor with no Mention inbox, so the
   * only meaningful recipient is a real local author. Consent and actor
   * resolution are already enforced by every caller (this only ever runs after
   * the engagement was recorded against a sharing-enabled local target by a
   * resolved actor); self-notification is prevented by `createNotification`.
   *
   * NEVER throws — a notification failure must not fail (and thus retry) the
   * inbox activity, mirroring {@link handleIncomingFollow}'s fail-soft notify.
   * Uses the same lazy import as the follow path to avoid the load-time cycle
   * (`notificationUtils` reaches the `server` singleton, and this connectors
   * module is itself pulled in by `server`).
   *
   * `postId` is the post whose owner is notified (a like/boost target, or a
   * reply's PARENT); `entityId` is what the notification points AT (the target
   * post for like/boost, the new reply post for reply) — mirroring the native
   * shapes exactly.
   */
  private async notifyLocalPostOwnerOfEngagement(
    postId: string,
    actorOxyUserId: string,
    type: 'like' | 'boost' | 'reply',
    entityId: string,
    entityType: 'post' | 'reply',
  ): Promise<void> {
    try {
      const post = await Post.findOne(
        { _id: postId },
        { authorship: 1, federation: 1 },
      ).lean<{ authorship?: PostAuthorshipEntry[]; federation?: unknown } | null>();
      if (!post || post.federation != null) return;

      const { createPostAuthorNotifications } = await import('../../utils/notificationUtils');
      await createPostAuthorNotifications(post.authorship, {
        actorId: actorOxyUserId,
        type,
        entityId,
        entityType,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[Federation] ${type} notification failed for post ${postId} from actor ${actorOxyUserId}: ${message}`,
      );
    }
  }

  /**
   * Best-effort: notify LOCAL users @mentioned by an inbound federated post,
   * mirroring the NATIVE compose/reply path (`createMentionNotifications` — the
   * SAME util `posts.controller` and `PostCreationService` call) so a Mastodon
   * mention of a Mention user reaches their notifications exactly like a native one.
   *
   * `localMentionIds` are already narrowed to LOCAL users (federated mentions are
   * stored on the post for rendering but have no Mention inbox to notify). Each is
   * gated on THAT user's own fediverse-sharing consent: a mention is inbound
   * engagement directed at the mentioned user, so a user with sharing off does not
   * receive fediverse-originated mention notifications — the same rule the inbound
   * Follow/reply/Like/Announce paths apply to their target. Fails OPEN per user on
   * an Oxy outage, like every other consent read on this inbound path.
   *
   * `actorOxyUserId` is the post AUTHOR (who did the mentioning); `entityId` is the
   * mentioning post. NEVER throws — a notification failure must not fail (and thus
   * retry) the inbox activity. Lazy import for the same load-time-cycle reason as
   * the sibling notify helpers.
   */
  private async notifyLocalMentionedUsers(
    localMentionIds: string[],
    actorOxyUserId: string,
    entityId: string,
    entityType: 'post' | 'reply',
  ): Promise<void> {
    try {
      const consented = (
        await Promise.all(
          localMentionIds.map(async (id) => ((await isFediverseSharingEnabled(id)) ? id : null)),
        )
      ).filter((id): id is string => id !== null);
      if (consented.length === 0) return;

      const { createMentionNotifications } = await import('../../utils/notificationUtils');
      await createMentionNotifications(consented, entityId, actorOxyUserId, entityType);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[Federation] mention notification failed for post ${entityId} from actor ${actorOxyUserId}: ${message}`,
      );
    }
  }

  /**
   * Undo(Like): delete the native `Like` doc for the (federated user, post) pair
   * and move `stats.likesCount` -1 ONLY when a doc was actually removed (floored
   * at 0). Mirrors the native unlike path so the counter stays in lockstep with
   * real records.
   *
   * Deliberately NOT gated on the target owner's sharing flag, unlike
   * `handleLike` — an Undo is teardown, not new engagement. The remote server
   * sends an Undo exactly once (it never re-sends after a dropped delivery),
   * and sharing OFF-cleanup only tears down follow edges, not stray Like
   * rows — so dropping this would leave the row and its counter contribution
   * permanently orphaned. Mirrors the pre-existing `handleUndo(Follow)`
   * branch above, which is likewise ungated.
   */
  private async handleUndoLike(likeObject: Record<string, any>, actorUri: string): Promise<void> {
    const likedObjectId = typeof likeObject.object === 'string' ? likeObject.object : likeObject.object?.id;
    if (!likedObjectId || typeof likedObjectId !== 'string') return;

    const postId = await resolvePostIdFromObjectUri(likedObjectId);
    if (!postId) return;

    const likerOxyUserId = await actorService.resolveActorOxyUserId(actorUri);
    if (!likerOxyUserId) return;

    const deleted = await Like.findOneAndDelete({ userId: likerOxyUserId, postId, value: 1 }).lean();
    if (!deleted) return;

    await Post.updateOne(
      { _id: postId, 'stats.likesCount': { $gt: 0 } },
      { $inc: { 'stats.likesCount': -1 } },
    );
    logger.debug(`[Federation] undo Like from ${actorUri} on ${postId}`);
  }

  /**
   * Undo(Announce): delete the native boost `Post` (matched by the Announce
   * `federation.activityId`, with the boosted-post fallback) and move
   * `stats.boostsCount` -1 ONLY when a boost Post was actually removed (floored
   * at 0).
   *
   * Deliberately NOT gated on the target owner's sharing flag, unlike
   * `handleAnnounce` — see the matching comment on `handleUndoLike` above:
   * an Undo is teardown, sent exactly once by the remote server, and the
   * sharing OFF-cleanup job doesn't touch boost rows, so dropping this would
   * permanently orphan the boost Post and its counter contribution. Mirrors
   * the pre-existing, likewise-ungated `handleUndo(Follow)` branch.
   */
  private async handleUndoAnnounce(announceObject: Record<string, any>, actorUri: string): Promise<void> {
    const announceId = typeof announceObject.id === 'string' ? announceObject.id : undefined;
    const announcedUri = extractAnnouncedObjectUri(announceObject.object);

    // Prefer the precise Announce-id match. Fall back to (boostOf, author) when
    // the Undo omits the original Announce id but carries the announced object.
    let boost: { _id: mongoose.Types.ObjectId; boostOf?: string } | null = null;
    if (announceId) {
      boost = await Post.findOne(
        { 'federation.activityId': announceId, type: 'boost' },
        { _id: 1, boostOf: 1 },
      ).lean<{ _id: mongoose.Types.ObjectId; boostOf?: string } | null>();
    }
    if (!boost && announcedUri) {
      const originalPostId = await resolvePostIdFromObjectUri(announcedUri);
      const boosterOxyUserId = await actorService.resolveActorOxyUserId(actorUri);
      if (originalPostId && boosterOxyUserId) {
        boost = await Post.findOne(
          { boostOf: originalPostId, oxyUserId: boosterOxyUserId, type: 'boost' },
          { _id: 1, boostOf: 1 },
        ).lean<{ _id: mongoose.Types.ObjectId; boostOf?: string } | null>();
      }
    }

    if (!boost?.boostOf) return;

    await Post.deleteOne({ _id: boost._id });
    await Post.updateOne(
      { _id: boost.boostOf, 'stats.boostsCount': { $gt: 0 } },
      { $inc: { 'stats.boostsCount': -1 } },
    );
    // The federated Announce incremented both counters in lockstep at import, so
    // mirror the decrement here. Guarded independently (its own `$gt: 0` filter,
    // a separate updateOne) so it never underflows AND never blocks the
    // boostsCount decrement above — federatedBoostsCount can legitimately lag
    // boostsCount on posts that predate the field until the backfill runs.
    await Post.updateOne(
      { _id: boost.boostOf, 'stats.federatedBoostsCount': { $gt: 0 } },
      { $inc: { 'stats.federatedBoostsCount': -1 } },
    );
    logger.debug(`[Federation] undo Announce from ${actorUri} (boost ${String(boost._id)})`);
  }

  /**
   * Handle an inbound Create whose Note is actually a POLL VOTE.
   *
   * Mastodon delivers a vote as a `Create` wrapping a `Note` that carries the
   * chosen option's TEXT in `name`, an `inReplyTo` pointing at the poll's
   * `Question` (our poll post's canonical AP id), and NO content — addressed to
   * the poll owner. This detects that shape and records the vote against the
   * local `Poll` through the SAME shared, atomic, idempotent path a local vote
   * uses ({@link pollVoteService}), so a redelivered/duplicate vote never
   * double-counts, a vote after close is rejected, and single-vs-multiple-choice
   * is honored.
   *
   * Returns `true` when the Create was a vote on one of OUR polls (whether or not
   * it was ultimately recorded — an unresolved voter, a sharing-off owner, a
   * closed poll, or an unknown option all still "consume" it so it never falls
   * through to the reply/post path). Returns `false` when it is not a poll vote
   * (missing `name`/`inReplyTo`, has real content, or the referenced post is not
   * a local poll), leaving {@link handleCreate} to process it as a normal
   * reply/post. Fail-soft is inherited from the shared helpers; nothing throws.
   */
  private async handlePollVote(object: Record<string, any>, actorUri: string): Promise<boolean> {
    // Shape gate — cheap checks first, no DB until the shape is a plausible vote.
    const name = typeof object.name === 'string' ? object.name.trim() : '';
    if (!name) return false;
    const inReplyToUri = extractInReplyToUri(object.inReplyTo);
    if (!inReplyToUri) return false;
    // A vote carries no body; a Note WITH content on a poll is a normal reply.
    const content = typeof object.content === 'string' ? object.content.trim() : '';
    if (content.length > 0) return false;

    // The `inReplyTo` must resolve to a LOCAL post that actually carries a poll.
    const postId = await resolvePostIdFromObjectUri(inReplyToUri);
    if (!postId) return false;
    const post = await Post.findOne({ _id: postId }, { 'content.pollId': 1 })
      .lean<{ content?: { pollId?: string } } | null>();
    const pollId = post?.content?.pollId;
    if (!pollId) return false; // reply to a non-poll post → let the normal path handle it

    // Unambiguously a vote on our poll from here — consume it regardless of outcome.

    // The poll owner may have turned fediverse sharing off — drop it silently.
    if (!(await this.isLocalPostOwnerSharingEnabled(postId))) {
      logger.debug(`[Federation] dropping poll vote from ${actorUri} on ${postId} — poll owner has sharing disabled`);
      return true;
    }

    // Resolve the remote voter to a native Oxy user (syncs the actor, like handleLike).
    const voterOxyUserId = await actorService.resolveActorOxyUserId(actorUri);
    if (!voterOxyUserId) {
      logger.info(`[Federation] skipping poll vote from ${actorUri} on ${postId}: unresolved actor`);
      return true;
    }

    const result = await pollVoteService.recordVoteByOptionText(String(pollId), name, voterOxyUserId);
    if (result.ok) {
      logger.debug(`[Federation] recorded poll vote from ${actorUri} on ${postId} (option="${name}")`);
    } else {
      logger.debug(`[Federation] poll vote from ${actorUri} on ${postId} not recorded (${result.reason})`);
    }
    return true;
  }

  private async handleCreate(activity: Record<string, any>, actorUri: string): Promise<void> {
    const object = activity.object;
    if (!object || typeof object !== 'object') return;
    if (object.type !== 'Note' && object.type !== 'Article') return;

    // Validate the embedded content object before reading its fields by raw
    // access. A Note/Article that fails validation (e.g. missing id) is skipped
    // with a warn rather than processed from a malformed shape.
    const parsedNote = parseNote(object);
    if (!parsedNote.ok) {
      logger.warn(
        `[Federation] skipping Create from ${actorUri}: invalid embedded ${object.type}: ${summarizeZodError(parsedNote.error)}`,
      );
      return;
    }

    // A remote poll VOTE arrives as a Create(Note) — chosen option in `name`,
    // `inReplyTo` = our poll's Question id, no content — and must be recorded
    // against the Poll BEFORE the follower gate below: a voter need not follow us.
    // Returns true only when this WAS a vote on one of our polls (handled + stop);
    // a genuine reply/post returns false and flows through unchanged.
    if (await this.handlePollVote(object, actorUri)) return;

    // Only process if the actor is followed by at least one local user
    const hasFollower = await FederatedFollow.exists({
      remoteActorUri: actorUri,
      direction: 'outbound',
      status: 'accepted',
    });
    if (!hasFollower) return;

    // Sanitize and check content length
    const rawContent = object.content || '';
    if (rawContent.length > FEDERATION_MAX_CONTENT_LENGTH) {
      logger.debug(`Rejecting oversized content from ${actorUri}`);
      return;
    }

    // Dedup by activityId
    const existingPost = await Post.exists({ 'federation.activityId': object.id });
    if (existingPost) return;

    // The Oxy link is MANDATORY: a federated post must carry a real Oxy author,
    // never a null one. Resolve the actor and REQUIRE its `oxyUserId`. When the
    // actor is missing or has no `oxyUserId` (Oxy unreachable when the actor was
    // resolved), `requireActorOxyUserId` throws `ActorResolutionPendingError` so
    // the BullMQ inbox job fails and retries with backoff — on a later attempt
    // (Oxy reachable) the actor resolves and the post inserts with a real author.
    // We NEVER insert an orphan post with a null author.
    const actor = await actorService.getOrFetchActor(actorUri);
    const authorOxyUserId = requireActorOxyUserId(actor, actorUri, `Create ${object.id}`);

    // Resolve the Note's @mentions BEFORE building the body: each `Mention` tag's
    // actor URI is resolved (and synced/created) to a federated or local Oxy user
    // id, then the matching in-content anchor is rewritten to Mention's internal
    // `[mention:<oxyUserId>]` placeholder so hydration renders it as a real link
    // (`@user@domain`) instead of dead `@user` text. Batched — each distinct actor
    // is resolved once. Runs after the dedup gate above, so a redelivered Create
    // never repeats the resolution.
    const mentionResult = await resolveInboundMentions(object);
    const noteObject = applyMentionPlaceholders(object, mentionResult.anchorMap);

    // Extract the body (with contentMap fallback), normalize hashtags, and
    // materialize media through the shared builder — the SAME path the outbox
    // backfill and boost/ancestor import use. A Note that carries nothing
    // storable (no text, no surviving media, no content-warning) is dropped
    // instead of persisted as a blank post.
    const built = await buildFederatedNoteContent(noteObject, authorOxyUserId, {
      activityId: object.id,
      actorUri,
    });
    if (built.skip) {
      logger.debug(`Skipping empty federated Create from ${actorUri} (${object.id}): ${built.reason}`);
      return;
    }
    const { media, attachments, hashtags, summary, sensitive, variants } = built;

    // Preserve the ORIGINAL publish date so a federated post reflects when it
    // was authored remotely, not when our inbox happened to receive it. The Note
    // carries its own `published`; fall back to the Create activity's `published`
    // (mirrors the outbox-backfill path). Mongoose 9's timestamps plugin honors a
    // `createdAt` supplied on a NEW document (it only fills the default when the
    // value is absent), so threading `createdAt`/`updatedAt` through
    // PostCreationService persists the real date without disabling timestamps.
    // Missing/invalid/future → undefined → schema timestamps fall back to now.
    const originalCreatedAt = parseApPublished(object.published ?? activity.published);

    // When this Note is a reply, resolve it to the local thread: parentPostId is
    // the parent Post's _id and threadId is the thread ROOT id (mirroring the
    // native reply rule). A parent not yet imported is backfilled (bounded) so
    // the reply joins the existing thread instead of being orphaned. `inReplyTo`
    // is normalized to a clean string URI (string IRI or embedded Link object).
    const inReplyToUri = extractInReplyToUri(object.inReplyTo);
    const threadLink = inReplyToUri
      ? await outboxSyncService.ensureFederatedReplyLink(inReplyToUri)
      : null;

    // A reply targets its parent post's owner — if that owner is a LOCAL
    // user who has turned fediverse sharing off, drop the reply silently
    // rather than materialize it against an opted-out account.
    if (threadLink && !(await this.isLocalPostOwnerSharingEnabled(threadLink.parentPostId))) {
      logger.debug(`[Federation] dropping reply Create from ${actorUri} — parent post owner has sharing disabled`);
      return;
    }

    // When this Note QUOTES another post, link it to the local quoted Post so
    // hydration embeds the quoted original (mirrors the native quote shape). The
    // quote URI is read from the standard AP quote surfaces (Bridgy Fed bridges a
    // Bluesky quote through them, pointing at the quoted post's brid.gy object
    // URL). Resolved only when the quoted post is ALREADY imported here — a
    // not-yet-imported quoted post leaves `quoteOf` null rather than blocking the
    // Create; it will link on a later pass once the original is ingested.
    const quoteUri = extractApQuoteUri(object);
    const quoteOf = quoteUri ? await resolvePostIdFromObjectUri(quoteUri) : null;

    const createdPost = await getPostCreator().create({
      oxyUserId: authorOxyUserId,
      federation: {
        activityId: object.id,
        actorUri,
        inReplyTo: inReplyToUri,
        url: object.url || object.id,
        sensitive,
        spoilerText: summary,
      },
      parentPostId: threadLink?.parentPostId ?? null,
      threadId: threadLink?.threadId ?? null,
      quoteOf,
      content: {
        // The body lives ONLY in the variants — a `contentMap` is one body PER
        // LANGUAGE, not a fallback for one. `variants[0]` is the primary.
        variants: variants.length > 0 ? variants : undefined,
        media: media.length > 0 ? media : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      visibility: mapApVisibility(object.to, object.cc),
      hashtags,
      // Resolved @mention Oxy user ids (federated + local) — the SAME allowlist the
      // native path stores, keyed by the `[mention:<id>]` placeholders now in the
      // body, so hydration renders each as a real profile link.
      mentions: mentionResult.ids,
      // AP-derived language so Mastodon/Pleroma posts carry their REAL language
      // (and feed the Stage-A classifier) instead of defaulting to 'en'. The
      // singular `language` sets the top-level `post.language` (primary); the full
      // declared set (top-level `language` + every `contentMap` key) feeds the
      // classifier's `postClassification.languages`.
      language: extractApLanguage(object),
      languages: extractApLanguages(object),
      // Instance host drives the Stage-A coarse region for federated posts.
      instanceDomain: getRemoteHost(actorUri),
      // AP actor type feeds the Stage-A RSS/bot-mirror spam signal.
      actorType: actor?.type,
      status: 'published',
      metadata: { isSensitive: sensitive },
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
      ...(originalCreatedAt ? { createdAt: originalCreatedAt, updatedAt: originalCreatedAt } : {}),
    });

    // A federated reply to a LOCAL post notifies the parent owner exactly like a
    // native reply (`type:'reply'`, entityId = the new reply post). Only reached
    // when this Create is genuinely new — the `federation.activityId` dedup above
    // returns early on a redelivery, so a redelivery never re-notifies.
    // `threadLink` is set only for replies, and the parent owner's sharing
    // consent was already enforced above; the helper skips a mirrored remote
    // parent (a federated author has no Mention inbox).
    if (threadLink?.parentPostId) {
      await this.notifyLocalPostOwnerOfEngagement(
        threadLink.parentPostId,
        authorOxyUserId,
        'reply',
        String(createdPost._id),
        'reply',
      );
    }

    // Notify LOCAL @mentioned users exactly like a native mention. Only reached on
    // a genuinely-new Create (the dedup gate returns early on a redelivery), so a
    // redelivered Create never re-notifies. Federated mentions are stored on the
    // post but not notified (no Mention inbox).
    if (mentionResult.localIds.length > 0) {
      await this.notifyLocalMentionedUsers(
        mentionResult.localIds,
        authorOxyUserId,
        String(createdPost._id),
        threadLink?.parentPostId ? 'reply' : 'post',
      );
    }

    logger.debug(`Stored federated post from ${actorUri}: ${object.id}`);
  }

  private async handleDelete(activity: Record<string, any>, actorUri: string): Promise<void> {
    const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    if (!objectId) return;

    const post = await Post.findOne({ 'federation.activityId': objectId, federation: { $ne: null } }).lean();
    if (!post) return;
    // Verify the deleting actor owns this post via Oxy user ID
    const actorRecord = await FederatedActor.findOne({ uri: actorUri }).lean();
    if (actorRecord && post.oxyUserId && actorRecord.oxyUserId !== post.oxyUserId) {
      logger.warn(`Delete rejected: actor ${actorUri} does not own post ${objectId}`);
      return;
    }
    await Post.deleteOne({ _id: post._id });
    logger.debug(`Deleted federated post: ${objectId}`);
  }

  /**
   * Inbound Like. Records the like with the SAME native structure as a local
   * like (a `Like` doc) and keeps `stats.likesCount` in lockstep: the counter
   * moves +1 only when a NEW Like doc is actually inserted. Redelivered Like
   * activities are no-ops (the unique `{userId, postId}` index makes the insert
   * idempotent). Skips entirely when the post or the federated user can't be
   * resolved, so the count only ever reflects real, listable likers.
   */
  private async handleLike(activity: Record<string, any>, actorUri: string): Promise<void> {
    const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    if (!objectId || typeof objectId !== 'string') return;

    const postId = await resolvePostIdFromObjectUri(objectId);
    if (!postId) return;

    if (!(await this.isLocalPostOwnerSharingEnabled(postId))) {
      logger.debug(`[Federation] dropping Like from ${actorUri} on ${postId} — target owner has sharing disabled`);
      return;
    }

    const likerOxyUserId = await actorService.resolveActorOxyUserId(actorUri);
    if (!likerOxyUserId) {
      logger.info(`[Federation] skipping Like from ${actorUri} on ${objectId}: unresolved actor`);
      return;
    }

    // Idempotent insert: a duplicate key means this actor already liked the post
    // (redelivered activity) — do not move the counter again.
    try {
      await Like.create({ userId: likerOxyUserId, postId, value: 1 });
    } catch (err) {
      if (isDuplicateKeyError(err)) return;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[Federation] failed to record Like from ${actorUri} on ${postId}: ${message}`);
      return;
    }

    await Post.updateOne({ _id: postId }, { $inc: { 'stats.likesCount': 1 } });
    logger.debug(`[Federation] recorded Like from ${actorUri} on ${postId}`);

    // Notify the local owner exactly like a native like. Only reached after a
    // NEW Like doc was inserted — a redelivered Like returns on the duplicate-key
    // path above, so a redelivery never re-notifies.
    await this.notifyLocalPostOwnerOfEngagement(postId, likerOxyUserId, 'like', postId, 'post');
  }

  /**
   * Inbound Announce (boost). Records EVERY booster relationally as a native
   * boost Post (`type:'boost'`, `boostOf:<local post _id>`, author = booster
   * Oxy user), deduped by the Announce `federation.activityId`. `stats.boostsCount`
   * moves +1 only when a NEW boost Post is created (no unconditional increment),
   * so the counter always equals the number of real boost records. Skips when the
   * booster or the boosted post can't be resolved.
   *
   * Feed visibility stays follow-gated naturally: feeds query `followingIds`, so
   * creating a boost Post for a non-followed booster populates the boost list and
   * count without flooding anyone's feed.
   */
  private async handleAnnounce(activity: Record<string, any>, actorUri: string): Promise<void> {
    const announcedUri = extractAnnouncedObjectUri(activity.object);
    if (!announcedUri) return;

    // A boost targets the announced post's owner — resolved separately from
    // `importAnnounce`'s own resolution below since the gate must run BEFORE
    // any booster-actor resolution or boost-record creation. `null` (not yet
    // mirrored locally, or a genuinely remote post) skips the gate: there is
    // no local owner to protect.
    const announcedPostId = await resolvePostIdFromObjectUri(announcedUri);
    if (announcedPostId && !(await this.isLocalPostOwnerSharingEnabled(announcedPostId))) {
      logger.debug(`[Federation] dropping Announce from ${actorUri} of ${announcedUri} — target owner has sharing disabled`);
      return;
    }

    // Record every booster as a real, listable user — resolve first and skip
    // when unresolvable so we never move the counter without a backing record.
    const boosterOxyUserId = await actorService.resolveActorOxyUserId(actorUri);
    if (!boosterOxyUserId) {
      logger.info(`[Federation] skipping Announce from ${actorUri} of ${announcedUri}: unresolved actor`);
      return;
    }

    // importAnnounce creates the native boost Post (deduped by Announce id) and
    // increments stats.boostsCount in lockstep only when a new boost is created.
    const created = await outboxSyncService.importAnnounce(activity, announcedUri, boosterOxyUserId);
    if (created) {
      logger.debug(`Imported boost from ${actorUri} of ${announcedUri}`);

      // Notify the local owner exactly like a native boost. Only reached when a
      // NEW boost Post was created (`importAnnounce` returns false on a
      // redelivered Announce), so a redelivery never re-notifies. `announcedPostId`
      // is the pre-resolved LOCAL post id; when null the boosted object is remote
      // (no local owner to notify), and the helper additionally skips mirrored
      // remote posts.
      if (announcedPostId) {
        await this.notifyLocalPostOwnerOfEngagement(announcedPostId, boosterOxyUserId, 'boost', announcedPostId, 'post');
      }
    }
  }

  private async handleUpdate(activity: Record<string, any>, actorUri: string): Promise<void> {
    const object = activity.object;
    if (!object || typeof object !== 'object') return;

    if (object.type === 'Note' || object.type === 'Article') {
      // Validate the edited content object before reading its fields by raw
      // access; skip a malformed edit with a warn.
      const parsedNote = parseNote(object);
      if (!parsedNote.ok) {
        logger.warn(
          `[Federation] skipping Update from ${actorUri}: invalid embedded ${object.type}: ${summarizeZodError(parsedNote.error)}`,
        );
        return;
      }

      // `object.id` is raw, remote-controlled AP JSON. Require a real string
      // BEFORE it flows into any Mongo filter: a non-string value (e.g.
      // `{ $gt: '' }`) would turn the equality match into an operator query
      // matching arbitrary posts (NoSQL injection). This proven-string barrier
      // is also the recognized CodeQL sanitizer for the query taint.
      const objectActivityId = object.id;
      if (typeof objectActivityId !== 'string' || objectActivityId.length === 0) return;

      // An Update may only edit the SENDING actor's OWN post. Scope every query
      // by both the activity id AND `federation.actorUri` (stamped at create on
      // the inbox Create + outbox backfill paths) so a remote server cannot
      // overwrite another actor's post by replaying its activityId.
      const editFilter = {
        'federation.activityId': objectActivityId,
        'federation.actorUri': actorUri,
      };

      const existingPost = await Post.findOne(editFilter, {
        oxyUserId: 1,
        mentions: 1,
        parentPostId: 1,
      }).lean<
        { _id: mongoose.Types.ObjectId; oxyUserId?: string | null; mentions?: unknown; parentPostId?: string | null } | null
      >();
      const ownerOxyUserId = existingPost?.oxyUserId ?? (await actorService.getOrFetchActor(actorUri))?.oxyUserId ?? null;

      // Re-resolve the edited Note's @mentions the SAME way as fresh ingest so an
      // edit's mentions stay correct: each `Mention` tag → federated/local Oxy user
      // id, the in-content anchors rewritten to `[mention:<id>]` placeholders.
      const mentionResult = await resolveInboundMentions(object);
      const noteObject = applyMentionPlaceholders(object, mentionResult.anchorMap);

      // Extract the edited body through the SAME shared logic as fresh ingest —
      // contentMap fallback, hashtag normalization, media materialization, and
      // CW/sensitive passthrough — so an edited contentMap-only / CW / all-hashtag
      // note keeps its body instead of being blanked. Edit semantics differ from
      // Create: NO empty-note guard here — an Update applies its consistently
      // extracted fields (set when present, unset when the edit removed them),
      // never skips/deletes.
      const built = await buildFederatedNoteContentForEdit(noteObject, ownerOxyUserId, {
        activityId: objectActivityId,
        actorUri,
      });

      const derivedType = built.media.length > 0
        ? (built.media.some((m) => m.type === 'video') ? PostType.VIDEO : PostType.IMAGE)
        : PostType.TEXT;

      const setOps: Record<string, unknown> = {
        hashtags: built.hashtags,
        type: derivedType,
        'federation.sensitive': built.sensitive,
        'metadata.isSensitive': built.sensitive,
        'metadata.isEdited': true,
        updatedAt: new Date(),
      };
      const unsetOps: Record<string, ''> = {};
      if (built.media.length > 0) setOps['content.media'] = built.media;
      else unsetOps['content.media'] = '';
      if (built.attachments.length > 0) setOps['content.attachments'] = built.attachments;
      else unsetOps['content.attachments'] = '';
      if (built.summary !== undefined) setOps['federation.spoilerText'] = built.summary;
      else unsetOps['federation.spoilerText'] = '';

      // The body. Variants are REPLACED wholesale by the edit, never merged.
      // Three consequences, all intended: the new body lands, a language the
      // author dropped from the edit disappears with it, and any machine
      // translation cached against the OLD body is discarded — a translation of
      // text that no longer exists is worse than no translation.
      if (built.variants.length > 0) setOps['content.variants'] = built.variants;
      else unsetOps['content.variants'] = '';

      // The edit's mention allowlist REPLACES the old one wholesale, mirroring the
      // body: dropping a mention from the text drops it from `mentions` too, so the
      // stored ids always match the `[mention:<id>]` placeholders now in the body.
      setOps.mentions = mentionResult.ids;

      const update: Record<string, unknown> = { $set: setOps };
      if (Object.keys(unsetOps).length > 0) update.$unset = unsetOps;
      await Post.updateOne(editFilter, update);
      logger.debug(`Updated federated post: ${objectActivityId}`);

      // Notify only NEWLY-added local mentions (diff against the post's prior
      // mentions), so a redelivered/unchanged Update never re-notifies while an
      // edit that adds a mention still reaches that user. Only meaningful when the
      // post already exists locally and has a resolved author.
      if (existingPost && ownerOxyUserId && mentionResult.localIds.length > 0) {
        const priorMentionIds = new Set(normalizeMentionIds(existingPost.mentions));
        const newLocalIds = mentionResult.localIds.filter((id) => !priorMentionIds.has(id));
        if (newLocalIds.length > 0) {
          await this.notifyLocalMentionedUsers(
            newLocalIds,
            ownerOxyUserId,
            String(existingPost._id),
            existingPost.parentPostId ? 'reply' : 'post',
          );
        }
      }
    } else if (object.type === 'Person' || object.type === 'Service' || object.type === 'Application') {
      // Profile update — re-fetch the actor to get updated data
      await actorService.fetchRemoteActor(actorUri);
      logger.debug(`Updated federated actor: ${actorUri}`);
    }
  }
}

export const inboxProcessingService = new InboxProcessingService();
export default inboxProcessingService;

/**
 * Bridge a federated follow edge into the Oxy follow graph via oxy-api's service
 * route `POST /federation/follow`. Idempotent on both sides: `follow` is a no-op
 * when the edge already exists and `unfollow` when it does not. Throws on
 * transport/HTTP failure so the BullMQ inbox job retries — the whole inbound-follow
 * (and Undo) sequence is retry-safe, so re-running converges. The engine's identity
 * adapter calls this for both directions.
 */
async function bridgeFollowEdge(
  followerUserId: string,
  targetUserId: string,
  action: 'follow' | 'unfollow',
): Promise<void> {
  await getServiceOxyClient().makeServiceRequest('POST', '/federation/follow', {
    followerUserId,
    targetUserId,
    action,
  });
}

/**
 * The shared inbound dispatcher. The engine validates the untrusted activity, owns
 * the follow protocol (Follow / Accept / Undo(Follow) / Reject — bridging the Oxy
 * edge via the identity adapter, recording the AP-side follow row via the store
 * adapter, sending the Accept via the delivery service), and hands every content
 * verb to Mention's {@link InboxProcessingService.onContentActivity}. Everything
 * app-specific is wired here.
 */
const inboundDispatcher = createInboundDispatcher({
  // Validate the untrusted activity against Mention's zod inbound schema, then
  // normalize the primary type (some servers send `type` as an array). The engine
  // owns the drop-with-warn behaviour; this only reports the verdict + summary.
  validateActivity: (activity) => {
    const parsed = parseInboundActivity(activity);
    if (!parsed.ok) return { ok: false, summary: summarizeZodError(parsed.error) };
    // The schema permits `type` as a single string OR an array; normalize to the
    // primary string. A validated activity always yields one, but guard for the
    // type — an empty/absent primary type is an activity we cannot dispatch.
    const type = primaryApType(parsed.data.type);
    if (!type) return { ok: false, summary: 'missing activity type' };
    return { ok: true, type };
  },
  identity: {
    // `resolveOxyUser` reaches the `server` singleton lazily (load-time cycle),
    // hence the wrapper rather than a bare reference.
    resolveUserByUsername: (username) => resolveOxyUser(username),
    bridgeFollow: (followerOxyUserId, localUserId) => bridgeFollowEdge(followerOxyUserId, localUserId, 'follow'),
    bridgeUnfollow: (followerOxyUserId, localUserId) => bridgeFollowEdge(followerOxyUserId, localUserId, 'unfollow'),
  },
  consent: { isSharingEnabledFromUser: (user) => isFediverseSharingEnabledFromUser(user) },
  actorResolver: { getOrFetchActor: (actorUri) => actorService.getOrFetchActor(actorUri) },
  follows: {
    upsertInboundAccepted: async (localUserId, remoteActorUri, activityId) => {
      await FederatedFollow.findOneAndUpdate(
        { localUserId, remoteActorUri, direction: 'inbound' },
        { $set: { status: 'accepted', activityId } },
        { upsert: true, returnDocument: 'after' },
      );
    },
    findInboundFollow: (remoteActorUri, localUserId) => {
      const filter: Record<string, unknown> = { remoteActorUri, direction: 'inbound' };
      if (localUserId) filter.localUserId = localUserId;
      return FederatedFollow.findOne(filter).lean<{ _id: unknown; localUserId: string } | null>();
    },
    deleteFollowById: async (id) => {
      await FederatedFollow.deleteOne({ _id: id });
    },
    findActorOxyUserId: async (uri) => {
      const actor = await FederatedActor.findOne({ uri }).lean<{ oxyUserId?: string } | null>();
      return actor?.oxyUserId ?? null;
    },
    // Accept (string ref / Follow object): match the outbound-pending row by its
    // activity id, or ANY pending row for this actor. Two methods so the engine
    // reproduces the exact original fallback (string ref tries id THEN any-pending;
    // a Follow object with an id tries id ONLY).
    markOutboundAcceptedByActivityId: async (remoteActorUri, activityId) => {
      const result = await FederatedFollow.updateOne(
        { remoteActorUri, direction: 'outbound', status: 'pending', activityId },
        { $set: { status: 'accepted' } },
      );
      return (result?.modifiedCount ?? 0) > 0;
    },
    markOutboundAcceptedAnyPending: async (remoteActorUri) => {
      const result = await FederatedFollow.updateOne(
        { remoteActorUri, direction: 'outbound', status: 'pending' },
        { $set: { status: 'accepted' } },
      );
      return (result?.modifiedCount ?? 0) > 0;
    },
    markOutboundRejected: async (remoteActorUri, activityId) => {
      const filter: Record<string, unknown> = { remoteActorUri, direction: 'outbound', status: 'pending' };
      if (activityId) filter.activityId = activityId;
      await FederatedFollow.updateOne(filter, { $set: { status: 'rejected' } });
    },
  },
  delivery: {
    sendAccept: (localOxyUserId, localUsername, followActivityId, remoteActorUri) =>
      deliveryService.sendAccept(localOxyUserId, localUsername, followActivityId, remoteActorUri),
  },
  // Fail-soft: the Oxy edge is already committed, so a notification failure must
  // never fail (and thus retry) the follow. Imported lazily — `notificationUtils`
  // reaches the `server` singleton, and this module is itself pulled in by `server`.
  onInboundFollowAccepted: async (localUserId, followerOxyUserId, actorUri) => {
    try {
      const { createNotification } = await import('../../utils/notificationUtils');
      await createNotification({
        recipientId: localUserId,
        actorId: followerOxyUserId,
        type: 'follow',
        entityId: followerOxyUserId,
        entityType: 'profile',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[Federation] follow notification failed for ${localUserId} from ${actorUri}: ${message}`);
    }
  },
  // Fire-and-forget: backfill the newly-followed actor's recent posts after Accept.
  onOutboundFollowAccepted: async (actorUri) => {
    const actor = await FederatedActor.findOne({ uri: actorUri }).lean();
    if (actor) {
      outboxSyncService.syncOutboxPosts(actor, 20).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to sync outbox after accept from ${actorUri}: ${message}`);
      });
    }
  },
  onContentActivity: (activity, verifiedActorUri) =>
    inboxProcessingService.onContentActivity(activity, verifiedActorUri),
  logger: {
    debug: (message) => logger.debug(message),
    info: (message) => logger.info(message),
    warn: (message, detail) => (detail === undefined ? logger.warn(message) : logger.warn(message, detail)),
  },
});
