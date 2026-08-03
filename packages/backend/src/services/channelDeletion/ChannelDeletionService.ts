/**
 * Executes {@link CHANNEL_CASCADE} — the destruction of one channel account's
 * content, and of every row in Mention's own database that points at it.
 *
 * WHAT THIS IS NOT
 *
 * It does not delete the Oxy account, its membership rows, its follow edges or
 * its uploaded bytes; those live on the far side of the Oxy boundary and are
 * enumerated in `OWNED_BY_OXY` rather than silently omitted.
 *
 * IT REFUSES ANYTHING THAT IS NOT A CHANNEL
 *
 * The account `kind` is resolved here, at the top of both entry points, before a
 * single post is read — see {@link NotAChannelAccountError}. It used to be the
 * caller's job, on the reasoning that no route calls this yet; the absence of a
 * route is the absence of an accident, not a defence, and pointing this at a
 * personal account destroys a person's writing irreversibly. An unresolvable kind
 * is a refusal too: `resolveAccountKind` is fail-soft to `null` by design and
 * leaves the decision to its caller, and the two directions here are not
 * comparable — refusing delays an administrative action, allowing may destroy the
 * wrong account's posts.
 *
 * THE MANIFEST IS THE PROGRAM
 *
 * Every write below is driven by an entry in `CHANNEL_CASCADE`. Nothing is
 * deleted that the manifest does not name, and every manifest entry is accounted
 * for in the result — under `steps` with a count when this service performs the
 * write, under `delegated` when `services/PostDeletionCascade.ts` owns the
 * disposition, and under `retained` when the row is deliberately kept.
 * `__tests__/services/channelDeletionService.test.ts` asserts that the three key
 * sets are disjoint and that their union is EXACTLY the manifest's, so a step
 * that stops executing disappears from all three and fails the build rather than
 * silently leaving rows behind. Delegated and retained steps carry no count on
 * purpose: a fabricated `0` is indistinguishable from a step that never ran,
 * which is the failure this binding exists to catch. Do not pre-seed `steps` from
 * the manifest either — that satisfies the assertion while executing nothing.
 *
 * RETRY CONTRACT
 *
 * Per-step failures are collected, every remaining step still runs, and the call
 * THROWS at the end — the `sharingCleanup.service.ts` throw-on-partial shape, so
 * a BullMQ worker retries against whatever survived. Every step is idempotent, so
 * a re-run converges: a second pass over an already-deleted channel returns
 * all-zero counts and does not throw.
 */

import type { Types } from 'mongoose';
import type { AccountKind } from '@oxyhq/contracts';
import { PostVisibility } from '@mention/shared-types';
import { CHANNEL_CASCADE, type CascadeStep } from './channelCascadeManifest';

import { Post } from '../../models/Post';
import Like from '../../models/Like';
import Bookmark from '../../models/Bookmark';
import PostRecentReplier from '../../models/PostRecentReplier';
import Poll from '../../models/Poll';
import Article from '../../models/Article';
import { Postgate } from '../../models/Postgate';
import { Threadgate } from '../../models/Threadgate';
import Notification from '../../models/Notification';
import EngagementOutbox from '../../models/EngagementOutbox';
import { FeedInteraction } from '../../models/FeedInteraction';
import { RepairFetchFailure } from '../../models/RepairFetchFailure';
import ContentLabel from '../../models/ContentLabel';
import ModerationEnforcement from '../../models/ModerationEnforcement';
import Report from '../../models/Report.model';
import FederationDeliveryQueue from '../../models/FederationDeliveryQueue';
import Lane from '../../models/Lane';
import LaneMute from '../../models/LaneMute';
import UserSettings from '../../models/UserSettings';
import ActorKeyPair from '../../models/ActorKeyPair';
import FederatedFollow from '../../models/FederatedFollow';
import { AuthorFollowerSnapshot } from '../../models/AuthorFollowerSnapshot';
import MentionSignedRecord from '../../models/MentionSignedRecord';
import MentionRepoHead from '../../models/MentionRepoHead';
import MentionUserNode from '../../models/MentionUserNode';
import MentionNodeIngestWitness from '../../models/MentionNodeIngestWitness';
import UserBehavior from '../../models/UserBehavior';
import UserFeedPreference from '../../models/UserFeedPreference';
import Mute from '../../models/Mute';
import { MuteWord } from '../../models/MuteWord';
import PostSubscription from '../../models/PostSubscription';
import { EntityFollow } from '../../models/EntityFollow';
import FeedLike from '../../models/FeedLike';
import FeedReview from '../../models/FeedReview';
import { FeedGenerator } from '../../models/FeedGenerator';
import Labeler from '../../models/Labeler';
import Poke from '../../models/Poke';
import PushToken from '../../models/PushToken';
import AccountList from '../../models/AccountList';
import CustomFeed from '../../models/CustomFeed';
import StarterPack from '../../models/StarterPack';
import EndorsementOutbox from '../../models/EndorsementOutbox';
import Trending from '../../models/Trending';
import FederatedActor from '../../models/FederatedActor';

import {
  assertPostsSafeToDelete,
  collectPostCascadeResidue,
  type PostDeletionTarget,
  type PostReferenceProbeName,
} from '../../scripts/lib/adminDeletionPreflight';
import {
  CASCADED_POST_REFERENCES,
  POST_REFERENCES_KEPT_BY_POLICY,
  cascadePostReferences,
  collectBoostClosure,
  type CascadedPostRow,
} from '../PostDeletionCascade';
import { resolveAccountKind } from '../publishAsAccount';
import { followService } from '../../connectors/activitypub/follow.service';
import { deliveryService } from '../../connectors/activitypub/delivery.service';
import { actorUrl } from '../../connectors/activitypub/constants';
import { AP_CONTEXT } from '@oxyhq/federation';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { logger } from '../../utils/logger';

const LOG_PREFIX = '[ChannelDeletion]';

/**
 * What this cascade tells the preflight about the post references it does not
 * have to prove absent, in the two shapes the gate distinguishes.
 *
 * Both lists are DERIVED from `POST_REFERENCE_DISPOSITION` rather than restated,
 * because the disposition of a post reference is that table's decision and a copy
 * here would be free to disagree with the code that actually runs. They are typed
 * `PostReferenceProbeName[]`, so a probe renamed or added upstream breaks this
 * build instead of being silently acknowledged.
 *
 *  - {@link CASCADED_POST_REFERENCES} is a CLAIM that the rows are gone, and it is
 *    verified after the fact by `collectPostCascadeResidue`.
 *  - {@link POST_REFERENCES_KEPT_BY_POLICY} is a decision that they STAY — the
 *    retained `Report.reportedId(post)` and the two durable queues whose live
 *    backlog is cancelled while their completed rows remain as a log. Declaring it
 *    as a claim instead would make the residue check report every one of them as a
 *    cascade leg that had stopped working.
 */
const REMOVED_BY_CASCADE: readonly PostReferenceProbeName[] = CASCADED_POST_REFERENCES;
const KEPT_BY_POLICY: readonly PostReferenceProbeName[] = POST_REFERENCES_KEPT_BY_POLICY;

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * The channel's OWN posts, projected as {@link CascadedPostRow} — the shape the
 * delegate reads — plus the two fields only this cascade needs.
 *
 * Reusing the delegate's row type is what lets the doomed set be handed over
 * whole; `visibility` and `status` are read here alone, to decide which posts a
 * remote server was ever told about and therefore needs a Tombstone for.
 */
interface ChannelPostRow extends CascadedPostRow {
  visibility?: string;
  status?: string;
}

/** Either spelling of a post id: a `Mixed` column stores both and Mongo casts neither. */
type PostIdValue = Types.ObjectId | string;

/**
 * Everything the cascade needs, resolved ONCE before any row is touched.
 *
 * Resolving up front is what makes the ordering safe: every step below filters on
 * an id set captured here, so deleting the posts cannot destroy the ids the
 * dependent sweeps are enumerated from, and a crash mid-cascade leaves a set a
 * re-run can rebuild from the surviving rows.
 */
interface DeletionTargets {
  readonly channelOxyUserId: string;
  /** The channel's own posts. */
  readonly channelPostIds: readonly PostIdValue[];
  readonly channelPostIdStrings: readonly string[];
  /** Public + published channel posts — the ones a `Delete(Tombstone)` is emitted for. */
  readonly federatablePostIds: readonly string[];
  /** Other people's boosts of them, transitively (see {@link collectBoostClosure}). */
  readonly boostPostIds: readonly PostIdValue[];
  /** The channel's posts UNION those boosts — every row this run destroys. */
  readonly doomedPostIds: readonly PostIdValue[];
  readonly doomedPostIdStrings: readonly string[];
  /**
   * The same rows, in the shape {@link cascadePostReferences} reads. Handed over
   * WHOLE rather than as ids: the delegate also reaches a post's owned `Poll` and
   * `Article` rows through `content.pollId` / `content.article.articleId`, which an
   * id list cannot carry.
   */
  readonly doomedRows: readonly CascadedPostRow[];
  /** The doomed ids PLUS the AP ids/urls those rows advertise (`channel-post-uris` scope). */
  readonly postKeys: readonly string[];
  /** The preflight's view of the same set. */
  readonly deletionTargets: readonly PostDeletionTarget[];
  readonly laneIds: readonly string[];
  /**
   * Originals that SURVIVE this run and lose a boost to it: one entry per channel
   * post that boosted somebody else's post.
   */
  readonly boostedOriginalIds: readonly string[];
  /** Surviving posts the channel liked: one entry per `Like` row being deleted. */
  readonly likedPostIds: readonly string[];
  /** Remote inboxes a `Delete(actor)` would reach. */
  readonly federatedFollowers: number;
  /** Other people's replies into the doomed set — expected to be 0. */
  readonly repliesByOthers: number;
  /** Other people's quotes of a doomed post; kept, pointer cleared. */
  readonly quotesByOthersKept: number;
}

/**
 * Deliberately the same fields the delegate's own boost-closure projection reads,
 * so the two halves of the doomed set are the same shape and the whole of it can
 * be handed to `cascadePostReferences` — plus `visibility`/`status`, which decide
 * which posts were ever advertised to a remote server.
 */
const POST_PROJECTION = {
  _id: 1,
  oxyUserId: 1,
  visibility: 1,
  status: 1,
  boostOf: 1,
  parentPostId: 1,
  federation: 1,
  'content.pollId': 1,
  'content.article.articleId': 1,
} as const;

function uriKeysOf(rows: readonly CascadedPostRow[]): string[] {
  return rows.flatMap((row) =>
    [row.federation?.activityId, row.federation?.url].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ),
  );
}

/**
 * Read every id set the cascade filters on. Strictly read-only, so both
 * {@link previewChannelDeletion} and the dry run share it unchanged.
 */
async function resolveDeletionTargets(channelOxyUserId: string): Promise<DeletionTargets> {
  // A channel post is reachable by the denormalized owner cache OR by its
  // authorship owner entry; the two are kept in sync by the `Post` pre-save hook,
  // but a cascade is the wrong place to depend on that having held for every row.
  const channelPosts = await Post.find(
    {
      $or: [
        { oxyUserId: channelOxyUserId },
        { authorship: { $elemMatch: { oxyUserId: channelOxyUserId, role: 'owner' } } },
      ],
    },
    POST_PROJECTION,
  ).lean<ChannelPostRow[]>();

  const channelPostIds = channelPosts.map((post) => post._id);
  const channelPostIdStrings = channelPostIds.map(String);

  // The delegate's closure, not a second one. It is transitive (a boost of a boost
  // is still a card with nothing behind it) and it REFUSES past its own cap rather
  // than truncating — a partially deboosted post leaves exactly the blank cards the
  // expansion prevents, and an operator needs to hear about it.
  const boostRows = await collectBoostClosure(channelPostIdStrings);
  if (boostRows === null) {
    throw new Error(
      `${LOG_PREFIX} refused to expand the boost closure for ${channelOxyUserId}: it exceeds the ` +
        'bound in PostDeletionCascade. Deleting a prefix of it would leave blank boost cards behind, ' +
        'so this needs an operator rather than a retry.',
    );
  }
  const boostPostIds = boostRows.map((post) => post._id);

  const doomedRows: CascadedPostRow[] = [...channelPosts, ...boostRows];
  const doomedPostIds = [...channelPostIds, ...boostPostIds];
  const doomedPostIdStrings = doomedPostIds.map(String);
  const doomedIdSet = new Set(doomedPostIdStrings);

  const [laneRows, likeRows, federatedFollowers, repliesByOthers, quotesByOthersKept] =
    await Promise.all([
      Lane.find({ ownerId: channelOxyUserId }, { _id: 1 }).lean<Array<{ _id: Types.ObjectId }>>(),
      Like.find({ userId: channelOxyUserId }, { postId: 1 }).lean<
        Array<{ postId: Types.ObjectId }>
      >(),
      FederatedFollow.countDocuments({
        localUserId: channelOxyUserId,
        direction: 'inbound',
        status: 'accepted',
      }),
      Post.countDocuments({
        parentPostId: { $in: channelPostIdStrings },
        _id: { $nin: doomedPostIds },
      }),
      Post.countDocuments({
        quoteOf: { $in: doomedPostIdStrings },
        _id: { $nin: doomedPostIds },
      }),
    ]);

  return {
    channelOxyUserId,
    channelPostIds,
    channelPostIdStrings,
    federatablePostIds: channelPosts
      .filter((post) => post.visibility === PostVisibility.PUBLIC && post.status === 'published')
      .map((post) => String(post._id)),
    boostPostIds,
    doomedPostIds,
    doomedPostIdStrings,
    doomedRows,
    postKeys: [...new Set([...doomedPostIdStrings, ...uriKeysOf(doomedRows)])],
    deletionTargets: doomedRows.map((post) => ({
      id: post._id,
      uris: uriKeysOf([post]),
    })),
    laneIds: laneRows.map((lane) => String(lane._id)),
    // A channel post that boosted somebody else's post: the original survives and
    // must lose the boost from its denormalized counter. A boost of another post
    // in the doomed set needs no repair — that post is going away too.
    boostedOriginalIds: channelPosts
      .map((post) => post.boostOf)
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && !doomedIdSet.has(id)),
    likedPostIds: likeRows
      .map((like) => String(like.postId))
      .filter((id) => !doomedIdSet.has(id)),
    federatedFollowers,
    repliesByOthers,
    quotesByOthersKept,
  };
}

// ---------------------------------------------------------------------------
// The step → Mongo binding table
// ---------------------------------------------------------------------------

/**
 * The order the phases run in, and what a crash inside each one leaves behind.
 * Each name is what the executor groups manifest steps by.
 */
type CascadePhase =
  /** Undelivered outbound activities from the channel. */
  | 'federation-drain'
  /** Rows that exist only as an attachment to a doomed post. */
  | 'post-dependents'
  /** Other people's posts that point INTO the doomed set. */
  | 'scrub-foreign-posts'
  /** The doomed `Post` rows themselves. */
  | 'doomed-posts'
  /** Rows keyed on the channel's lanes. */
  | 'lanes'
  /** Rows keyed on the channel account. */
  | 'account';

/** How a schema stores a post id, so a `$in` is built in the type it can match. */
type PostIdForm = 'objectId' | 'string' | 'both';

/**
 * The three operations the cascade performs, typed structurally so ONE table can
 * hold models of different document shapes without an `any` in sight.
 */
interface CascadeCollection {
  countDocuments(filter: Record<string, unknown>): PromiseLike<number>;
  deleteMany(filter: Record<string, unknown>): PromiseLike<{ deletedCount: number }>;
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): PromiseLike<{ modifiedCount: number }>;
}

/**
 * A manifest step whose disposition belongs to `services/PostDeletionCascade.ts`.
 *
 * `leg` names the reference the delegate covers, and it is typed
 * `PostReferenceProbeName` so the COMPILER holds the two files together: a probe
 * renamed upstream breaks this build rather than leaving a step delegated to a leg
 * that no longer exists. It is documentation with a gate on it, not a lookup key —
 * the delegate is handed the whole doomed set once and decides its own legs.
 */
interface DelegatedBinding {
  readonly delegated: true;
  readonly leg: PostReferenceProbeName;
}

interface LocalStepBinding {
  readonly collection: CascadeCollection;
  readonly phase: CascadePhase;
  /**
   * Tiebreaker WITHIN a phase; steps otherwise run in manifest order. Only one
   * step needs it, and the reason is on that entry — a step whose count can only
   * ever be zero is a step nobody can verify.
   */
  readonly order?: number;
  /** The Mongo path carrying the reference, when it is not the manifest's `field`. */
  readonly path?: string;
  /** Extra terms ANDed into the scope-derived filter. */
  readonly match?: Readonly<Record<string, unknown>>;
  /** Only read for `channel-posts` scope. Defaults to `'string'`. */
  readonly idForm?: PostIdForm;
  /**
   * `pull-from-array` over an array of SUBDOCUMENTS: the array to `$pull` from and
   * the key inside each element that carries the reference. Without it the array
   * is assumed to hold the referenced ids directly.
   */
  readonly pullSubdocument?: { readonly arrayPath: string; readonly elementKey: string };
  /** Replaces the scope-derived filter for the references a plain `$in` cannot express. */
  readonly filter?: (targets: DeletionTargets) => Record<string, unknown>;
}

type StepBinding = LocalStepBinding | DelegatedBinding;

function isDelegated(binding: StepBinding): binding is DelegatedBinding {
  return 'delegated' in binding;
}

/** A manifest entry's identity. `Notification.entityId` appears under two scopes. */
function bindingKey(step: CascadeStep): string {
  return `${step.model}.${step.field}|${step.scope}`;
}

/** The key a step reports its count under. The two `Notification.entityId` steps share one. */
function stepKey(step: CascadeStep): string {
  return `${step.model}.${step.field}`;
}

/**
 * The ONE place a manifest step's Mongo shape is written down: which collection,
 * which phase, and — where the schema path differs from the manifest's field name
 * or the filter needs a term the scope cannot supply — exactly how.
 *
 * Kept in manifest order so the two files diff against each other, and because
 * within a phase the executor runs steps in that order.
 */
const STEP_BINDINGS: Readonly<Record<string, StepBinding>> = {
  // --- Engagement and derived rows ON the destroyed posts --------------------
  // DELEGATED to `PostDeletionCascade.cascadePostReferences` — the live delete
  // route's own implementation of "what happens to a reference on a post that is
  // gone", whose `POST_REFERENCE_DISPOSITION` is a `Record` over the preflight's
  // probe list and therefore breaks its own build when a reference type is added.
  // A second copy here would destroy that property. See the manifest's block
  // comment for the full argument.
  'Like.postId|channel-posts': { delegated: true, leg: 'Like.postId' },
  'Bookmark.postId|channel-posts': { delegated: true, leg: 'Bookmark.postId' },
  'PostRecentReplier.postId|channel-posts': {
    delegated: true,
    leg: 'PostRecentReplier.postId',
  },
  'Poll.postId|channel-posts': { delegated: true, leg: 'Poll.postId' },
  'Article.postId|channel-posts': { delegated: true, leg: 'Article.postId' },
  'Postgate.postId|channel-posts': { delegated: true, leg: 'Postgate.postId/postUri' },
  'Postgate.postUri|channel-post-uris': { delegated: true, leg: 'Postgate.postId/postUri' },
  'Threadgate.postId|channel-posts': { delegated: true, leg: 'Threadgate.postId/postUri' },
  'Threadgate.postUri|channel-post-uris': {
    delegated: true,
    leg: 'Threadgate.postId/postUri',
  },
  // Someone else's postgate listing a doomed post among its detached quotes: the
  // row is theirs and stays, only the entry goes. NOT delegated — the delegate
  // deletes the postgate rows that BELONG to a doomed post, which is a different
  // question from an entry naming one inside a stranger's row.
  'Postgate.detachedQuoteUris|channel-post-uris': {
    collection: Postgate,
    phase: 'scrub-foreign-posts',
  },
  // `entityId` holds a POST id only when `entityType` is post/reply — that half is
  // the delegate's. The SAME column holds an oxyUserId for a profile notification,
  // which is a channel reference and has no delegate leg, so it runs here.
  'Notification.entityId|channel-posts': { delegated: true, leg: 'Notification.entityId' },
  'Notification.entityId|channel-account': {
    collection: Notification,
    phase: 'account',
    match: { entityType: 'profile' },
  },
  'EngagementOutbox.postId|channel-posts': {
    delegated: true,
    leg: 'EngagementOutbox.payload.postId',
  },
  'FeedInteraction.postUri|channel-post-uris': {
    delegated: true,
    leg: 'FeedInteraction.postUri',
  },
  'RepairFetchFailure.postId|channel-posts': {
    collection: RepairFetchFailure,
    phase: 'post-dependents',
  },
  // `targetId` is polymorphic on `targetType`, so the column is two references and
  // the manifest gives it two steps. The post rows are the delegate's; the
  // user-scoped rows are a label applied TO the channel, which nothing else
  // sweeps.
  'ContentLabel.targetId|channel-posts': {
    delegated: true,
    leg: 'ContentLabel.targetId(post)',
  },
  'ContentLabel.targetId|channel-account': {
    collection: ContentLabel,
    phase: 'account',
    match: { targetType: 'user' },
  },
  'ModerationEnforcement.subjectId|channel-posts': {
    collection: ModerationEnforcement,
    phase: 'post-dependents',
  },
  // `Report.model.reportedId` and `ModerationOutbox.reportId` have NO binding: the
  // manifest gives them the `retain` action, so there is nothing to execute and a
  // binding for them would be a query nobody may run. The reasons are on those
  // entries; the short version is that removing a report leaves an inbound
  // CrowdSource decision retrying until it expires.
  //
  // Hoisted OUT of the account phase and into the drain: the manifest requires
  // these to go before the actor Delete is broadcast, or a queued Create races it
  // and republishes a post on the receiving instance.
  'FederationDeliveryQueue.senderOxyUserId|channel-account': {
    collection: FederationDeliveryQueue,
    phase: 'federation-drain',
  },

  // --- Other people's POSTS that point INTO the destroyed set ----------------
  // The boost ROWS themselves; they are already in the doomed set, so this deletes
  // by id rather than by `boostOf` and cannot reach a post outside it.
  'Post.boostOf|channel-posts': {
    collection: Post,
    phase: 'doomed-posts',
    order: 1,
    filter: (targets) => ({ _id: { $in: targets.boostPostIds } }),
  },
  // `$nin` the doomed set so the count means "somebody else's post scrubbed" —
  // the doomed rows carrying the same pointer are deleted outright below.
  'Post.quoteOf|channel-posts': {
    collection: Post,
    phase: 'scrub-foreign-posts',
    filter: (targets) => ({
      quoteOf: { $in: targets.doomedPostIdStrings },
      _id: { $nin: targets.doomedPostIds },
    }),
  },
  'Post.parentPostId|channel-posts': {
    collection: Post,
    phase: 'scrub-foreign-posts',
    filter: (targets) => ({
      parentPostId: { $in: targets.doomedPostIdStrings },
      _id: { $nin: targets.doomedPostIds },
    }),
  },
  'Post.threadId|channel-posts': {
    collection: Post,
    phase: 'scrub-foreign-posts',
    filter: (targets) => ({
      threadId: { $in: targets.doomedPostIdStrings },
      _id: { $nin: targets.doomedPostIds },
    }),
  },
  'Post.mentions|channel-account': { collection: Post, phase: 'account' },

  // --- The channel's own posts ----------------------------------------------
  // Deleted by the resolved id set, not by owner: that set is what the preflight
  // cleared and what every dependent sweep above was enumerated from, so a row
  // created since resolution is left for the next run rather than deleted with
  // its dependents unswept.
  'Post.oxyUserId|channel-account': {
    collection: Post,
    phase: 'doomed-posts',
    order: 3,
    filter: (targets) => ({ _id: { $in: targets.doomedPostIds } }),
  },
  // The doomed rows that name a writer, destroyed FIRST among the authored posts
  // (`order`) so the count means something: how many of the channel's posts had a
  // human behind them. Left in manifest order it would run after the owner-keyed
  // delete had already taken every doomed row, and a step that can only ever
  // report zero is a step no test can tell from a broken one.
  //
  // The row is DELETED. It is never handed to the person named in
  // `writtenByOxyUserId` — with `signPosts` off that would retroactively publish
  // who wrote what, the single promise a channel makes, broken at the moment the
  // channel is no longer there to answer for it.
  'Post.writtenByOxyUserId|channel-posts': {
    collection: Post,
    phase: 'doomed-posts',
    order: 2,
    filter: (targets) => ({
      _id: { $in: targets.doomedPostIds },
      writtenByOxyUserId: { $exists: true },
    }),
  },
  'Post.laneId|channel-lanes': { collection: Post, phase: 'lanes' },

  // --- Rows keyed on the channel ACCOUNT -------------------------------------
  'Lane.ownerId|channel-account': { collection: Lane, phase: 'account' },
  'LaneMute.laneId|channel-lanes': { collection: LaneMute, phase: 'lanes' },
  'LaneMute.laneOwnerOxyUserId|channel-account': { collection: LaneMute, phase: 'account' },
  'LaneMute.viewerOxyUserId|channel-account': { collection: LaneMute, phase: 'account' },
  'UserSettings.oxyUserId|channel-account': { collection: UserSettings, phase: 'account' },
  // Another person's privacy settings naming the channel; the array is nested
  // under `privacy`, and the row is theirs so only the entry goes.
  'UserSettings.restrictedUsers|channel-account': {
    collection: UserSettings,
    phase: 'account',
    path: 'privacy.restrictedUsers',
  },
  'ActorKeyPair.oxyUserId|channel-account': { collection: ActorKeyPair, phase: 'account' },
  'FederatedFollow.localUserId|channel-account': { collection: FederatedFollow, phase: 'account' },
  'AuthorFollowerSnapshot.oxyUserId|channel-account': {
    collection: AuthorFollowerSnapshot,
    phase: 'account',
  },
  'MentionSignedRecord.oxyUserId|channel-account': {
    collection: MentionSignedRecord,
    phase: 'account',
  },
  'MentionRepoHead.oxyUserId|channel-account': { collection: MentionRepoHead, phase: 'account' },
  'MentionUserNode.oxyUserId|channel-account': { collection: MentionUserNode, phase: 'account' },
  'MentionNodeIngestWitness.oxyUserId|channel-account': {
    collection: MentionNodeIngestWitness,
    phase: 'account',
  },
  'Notification.recipientId|channel-account': { collection: Notification, phase: 'account' },
  'Notification.actorId|channel-account': { collection: Notification, phase: 'account' },
  'EngagementOutbox.actorOxyUserId|channel-account': {
    collection: EngagementOutbox,
    phase: 'account',
    path: 'payload.actorOxyUserId',
  },
  'EngagementOutbox.postOwnerOxyUserId|channel-account': {
    collection: EngagementOutbox,
    phase: 'account',
    path: 'payload.postOwnerOxyUserId',
  },
  'UserBehavior.oxyUserId|channel-account': { collection: UserBehavior, phase: 'account' },
  // `preferredAuthors` is an array of SUBDOCUMENTS keyed on `authorId`. The
  // manifest classifies it under both names, so both steps run: the first pulls
  // the entries, the second re-runs the identical pull and legitimately reports 0
  // in a live run (in a dry run both report the same rows, which are the same
  // rows).
  'UserBehavior.authorId|channel-account': {
    collection: UserBehavior,
    phase: 'account',
    path: 'preferredAuthors.authorId',
    pullSubdocument: { arrayPath: 'preferredAuthors', elementKey: 'authorId' },
  },
  'UserBehavior.preferredAuthors|channel-account': {
    collection: UserBehavior,
    phase: 'account',
    path: 'preferredAuthors.authorId',
    pullSubdocument: { arrayPath: 'preferredAuthors', elementKey: 'authorId' },
  },
  'UserBehavior.hiddenAuthors|channel-account': { collection: UserBehavior, phase: 'account' },
  'UserBehavior.mutedAuthors|channel-account': { collection: UserBehavior, phase: 'account' },
  'UserBehavior.blockedAuthors|channel-account': { collection: UserBehavior, phase: 'account' },
  'UserFeedPreference.oxyUserId|channel-account': {
    collection: UserFeedPreference,
    phase: 'account',
  },
  'Mute.mutedId|channel-account': { collection: Mute, phase: 'account' },
  'Mute.userId|channel-account': { collection: Mute, phase: 'account' },
  'MuteWord.userId|channel-account': { collection: MuteWord, phase: 'account' },
  'Like.userId|channel-account': { collection: Like, phase: 'account' },
  'Bookmark.userId|channel-account': { collection: Bookmark, phase: 'account' },
  'PostSubscription.subscriberId|channel-account': {
    collection: PostSubscription,
    phase: 'account',
  },
  'PostSubscription.authorId|channel-account': { collection: PostSubscription, phase: 'account' },
  // The channel inside another post's replier projection: an array of
  // subdocuments, and that post belongs to someone else.
  'PostRecentReplier.oxyUserId|channel-account': {
    collection: PostRecentReplier,
    phase: 'account',
    path: 'repliers.oxyUserId',
    pullSubdocument: { arrayPath: 'repliers', elementKey: 'oxyUserId' },
  },
  'EntityFollow.userId|channel-account': { collection: EntityFollow, phase: 'account' },
  'FeedInteraction.userId|channel-account': { collection: FeedInteraction, phase: 'account' },
  'FeedLike.userId|channel-account': { collection: FeedLike, phase: 'account' },
  'FeedReview.reviewerId|channel-account': { collection: FeedReview, phase: 'account' },
  'FeedGenerator.createdBy|channel-account': { collection: FeedGenerator, phase: 'account' },
  'Labeler.creatorId|channel-account': { collection: Labeler, phase: 'account' },
  'Poke.pokerId|channel-account': { collection: Poke, phase: 'account' },
  'Poke.pokedId|channel-account': { collection: Poke, phase: 'account' },
  'PushToken.userId|channel-account': { collection: PushToken, phase: 'account' },
  'Poll.createdBy|channel-account': { collection: Poll, phase: 'account' },
  'Article.createdBy|channel-account': { collection: Article, phase: 'account' },
  'Postgate.createdBy|channel-account': { collection: Postgate, phase: 'account' },
  'Threadgate.createdBy|channel-account': { collection: Threadgate, phase: 'account' },
  'ContentLabel.createdBy|channel-account': { collection: ContentLabel, phase: 'account' },
  'Report.model.reporter|channel-account': {
    collection: Report,
    phase: 'account',
    path: 'reporter',
  },
  'AccountList.ownerOxyUserId|channel-account': { collection: AccountList, phase: 'account' },
  'AccountList.memberOxyUserIds|channel-account': { collection: AccountList, phase: 'account' },
  'CustomFeed.ownerOxyUserId|channel-account': { collection: CustomFeed, phase: 'account' },
  'CustomFeed.memberOxyUserIds|channel-account': { collection: CustomFeed, phase: 'account' },
  'StarterPack.ownerOxyUserId|channel-account': { collection: StarterPack, phase: 'account' },
  'StarterPack.memberOxyUserIds|channel-account': { collection: StarterPack, phase: 'account' },
  'StarterPack.usedByOxyUserIds|channel-account': { collection: StarterPack, phase: 'account' },
  'EndorsementOutbox.pendingRemoveOwnerId|channel-account': {
    collection: EndorsementOutbox,
    phase: 'account',
  },
  'EndorsementOutbox.pendingRemoveMemberIds|channel-account': {
    collection: EndorsementOutbox,
    phase: 'account',
  },
  'Trending.actorIds|channel-account': { collection: Trending, phase: 'account' },
  'FederatedActor.oxyUserId|channel-account': { collection: FederatedActor, phase: 'account' },
};

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

/**
 * Count (dry run) or delete (live), returning the affected-row count either way.
 * With {@link countOrUpdate} this is the single chokepoint that keeps a dry run
 * strictly read-only — mirrors `scripts/purgeGoneFederatedActors.ts`.
 */
async function countOrDelete(
  collection: CascadeCollection,
  filter: Record<string, unknown>,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) return collection.countDocuments(filter);
  const result = await collection.deleteMany(filter);
  return result.deletedCount;
}

/** Count (dry run) or apply an `$unset`/`$pull` (live). */
async function countOrUpdate(
  collection: CascadeCollection,
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) return collection.countDocuments(filter);
  const result = await collection.updateMany(filter, update);
  return result.modifiedCount;
}

/** The ids a `channel-posts` step filters on, in the spelling its schema stores. */
function postIdsFor(binding: LocalStepBinding, targets: DeletionTargets): unknown[] {
  switch (binding.idForm ?? 'string') {
    case 'objectId':
      return [...targets.doomedPostIds];
    case 'both':
      return [...targets.doomedPostIds, ...targets.doomedPostIdStrings];
    case 'string':
      return [...targets.doomedPostIdStrings];
  }
}

/** The single value (account scope) or value set (every other scope) a step matches. */
function scopeOperand(
  step: CascadeStep,
  binding: LocalStepBinding,
  targets: DeletionTargets,
): unknown {
  switch (step.scope) {
    case 'channel-account':
      return targets.channelOxyUserId;
    case 'channel-lanes':
      return { $in: [...targets.laneIds] };
    case 'channel-post-uris':
      return { $in: [...targets.postKeys] };
    case 'channel-posts':
      return { $in: postIdsFor(binding, targets) };
  }
}

function buildFilter(
  step: CascadeStep,
  binding: LocalStepBinding,
  targets: DeletionTargets,
): Record<string, unknown> {
  if (binding.filter) return binding.filter(targets);
  return {
    [binding.path ?? step.field]: scopeOperand(step, binding, targets),
    ...binding.match,
  };
}

function buildPullUpdate(
  step: CascadeStep,
  binding: LocalStepBinding,
  targets: DeletionTargets,
): Record<string, unknown> {
  const operand = scopeOperand(step, binding, targets);
  if (binding.pullSubdocument) {
    const { arrayPath, elementKey } = binding.pullSubdocument;
    return { $pull: { [arrayPath]: { [elementKey]: operand } } };
  }
  return { $pull: { [binding.path ?? step.field]: operand } };
}

async function executeStep(
  step: CascadeStep,
  binding: LocalStepBinding,
  targets: DeletionTargets,
  dryRun: boolean,
): Promise<number> {
  const filter = buildFilter(step, binding, targets);
  switch (step.action) {
    case 'delete-row':
      return countOrDelete(binding.collection, filter, dryRun);
    case 'unset-field':
      return countOrUpdate(
        binding.collection,
        filter,
        { $unset: { [binding.path ?? step.field]: '' } },
        dryRun,
      );
    case 'pull-from-array':
      return countOrUpdate(
        binding.collection,
        filter,
        buildPullUpdate(step, binding, targets),
        dryRun,
      );
    case 'retain':
      // Unreachable: `buildSchedule` never schedules a retained step, precisely so
      // no query for one can exist. Kept as a real throw rather than a silent
      // fall-through so a future binding that contradicts the manifest is loud.
      throw new Error(
        `${LOG_PREFIX} ${bindingKey(step)} is retained by the manifest and must not be executed`,
      );
  }
}

/**
 * Accumulates what happened to every manifest step, and the failures that make
 * the call throw at the end.
 *
 * Three disjoint accounts, because "this ran and affected N rows", "somebody else
 * owns this" and "this is deliberately kept" are three different statements and
 * collapsing them loses the only one that matters. Counting a delegated or
 * retained step as `0` would be the worst of the three options: indistinguishable
 * from a step that silently stopped running, which is the exact failure the
 * manifest binding exists to catch.
 */
class CascadeRun {
  readonly steps: Record<string, number> = {};
  readonly failures: string[] = [];
  private readonly delegatedKeys = new Set<string>();
  private readonly retainedKeys = new Set<string>();

  record(key: string, count: number): void {
    this.steps[key] = (this.steps[key] ?? 0) + count;
  }

  delegate(key: string): void {
    this.delegatedKeys.add(key);
  }

  retain(key: string): void {
    this.retainedKeys.add(key);
  }

  fail(key: string, error: unknown): void {
    this.failures.push(key);
    logger.error(`${LOG_PREFIX} cascade step failed`, error);
  }

  /**
   * A failure the delegate has ALREADY logged with its own leg name; recorded so
   * the run still throws and a BullMQ retry re-runs it. Not logged a second time —
   * two entries for one failure read as two failures.
   */
  failDelegated(reference: string): void {
    this.failures.push(`PostDeletionCascade:${reference}`);
  }

  /**
   * The delegated and retained key lists, made DISJOINT from `steps`.
   *
   * Two columns are classified twice by scope — `Notification.entityId` and
   * `ContentLabel.targetId` each hold a post id under one `entityType`/`targetType`
   * and an account id under another — so one step key can have both a delegated
   * entry and a locally executed one. Local wins, because a real count is more
   * informative than a label and because the count would otherwise be silently
   * dropped from the result. The manifest entry for the delegated half says so in
   * its `why`, which is where a reader looks for the disposition anyway.
   */
  classify(): { delegated: string[]; retained: string[] } {
    const local = new Set(Object.keys(this.steps));
    return {
      delegated: [...this.delegatedKeys].filter((key) => !local.has(key)).sort(),
      retained: [...this.retainedKeys]
        .filter((key) => !local.has(key) && !this.delegatedKeys.has(key))
        .sort(),
    };
  }
}

interface ScheduledStep {
  readonly step: CascadeStep;
  /** Only a LOCAL binding is ever scheduled — a delegated one has no query here. */
  readonly binding: LocalStepBinding;
}
type CascadeSchedule = ReadonlyMap<CascadePhase, readonly ScheduledStep[]>;

/**
 * Account for every manifest step exactly once, and group the ones this service
 * executes under the phase that runs them.
 *
 * Done in ONE pass over the manifest rather than per phase, so a step with no
 * binding is reported once rather than once per phase — and so the delegated and
 * retained accounts are complete even in a dry run, where the delegate is never
 * called.
 */
function buildSchedule(run: CascadeRun): CascadeSchedule {
  const schedule = new Map<CascadePhase, ScheduledStep[]>();

  for (const step of CHANNEL_CASCADE) {
    // The manifest's own action decides this, ahead of any binding lookup: a
    // retained row has no query, and a binding for one would be a query nobody may
    // run.
    if (step.action === 'retain') {
      run.retain(stepKey(step));
      continue;
    }
    const binding = STEP_BINDINGS[bindingKey(step)];
    if (!binding) {
      run.fail(bindingKey(step), new Error(`no Mongo binding for cascade step ${bindingKey(step)}`));
      continue;
    }
    if (isDelegated(binding)) {
      run.delegate(stepKey(step));
      continue;
    }
    const bucket = schedule.get(binding.phase);
    if (bucket) bucket.push({ step, binding });
    else schedule.set(binding.phase, [{ step, binding }]);
  }

  // A stable sort, so an entry without an `order` keeps its manifest position.
  for (const bucket of schedule.values()) {
    bucket.sort((left, right) => (left.binding.order ?? 0) - (right.binding.order ?? 0));
  }
  return schedule;
}

/**
 * Run every manifest step assigned to one phase.
 *
 * A step that throws still records its key (as 0) so the result stays a complete
 * description of the manifest, and the failure is collected for the throw at the
 * end. A step with NO binding records nothing — the missing key is what the
 * manifest-binding test reports.
 */
async function runPhase(
  phase: CascadePhase,
  schedule: CascadeSchedule,
  targets: DeletionTargets,
  dryRun: boolean,
  run: CascadeRun,
): Promise<void> {
  for (const { step, binding } of schedule.get(phase) ?? []) {
    try {
      run.record(stepKey(step), await executeStep(step, binding, targets, dryRun));
    } catch (error) {
      run.record(stepKey(step), 0);
      run.fail(stepKey(step), error);
    }
  }
}

// ---------------------------------------------------------------------------
// Federation
// ---------------------------------------------------------------------------

/**
 * Tell the fediverse the posts and then the actor are gone, BEFORE anything they
 * are addressed from is deleted: `deliverToFollowers` resolves its inboxes from
 * the `FederatedFollow` rows, which the account phase removes.
 *
 * The username is resolved SERVER-SIDE from the authoritative `oxyUserId` — the
 * canonical Note ids a remote server matches against are minted from it, and no
 * request-scoped value is trusted for it. A resolve miss THROWS before any row is
 * deleted, so the run is retried rather than leaving remote copies with no local
 * post left to address a later Delete from.
 *
 * Skipped entirely when the channel has no accepted inbound followers: there is
 * nobody to deliver to, so it would be a round trip to Oxy for no delivery.
 */
async function broadcastFederatedDelete(targets: DeletionTargets): Promise<void> {
  if (targets.federatedFollowers === 0) return;

  const user = await getServiceOxyClient().getUserById(targets.channelOxyUserId);
  const username = user.username?.trim();
  if (!username) {
    throw new Error(
      `${LOG_PREFIX} cannot federate the deletion of ${targets.channelOxyUserId}: no resolvable username`,
    );
  }

  // Per-post Tombstones first: once the actor is deleted a remote server may drop
  // the account wholesale, and an instance that does not still needs each status
  // named. `federateDelete` is best-effort by design and never throws.
  for (const postId of targets.federatablePostIds) {
    await followService.federateDelete({ _id: postId }, targets.channelOxyUserId, username);
  }

  const actor = actorUrl(username);
  await deliveryService.deliverToFollowers(
    {
      '@context': AP_CONTEXT,
      id: `${actor}#delete-${Date.now()}`,
      type: 'Delete',
      actor,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: actor,
    },
    targets.channelOxyUserId,
    username,
  );
}

// ---------------------------------------------------------------------------
// Counter repair
// ---------------------------------------------------------------------------

/**
 * Repair the denormalized counters on posts that SURVIVE this run but lose an
 * engagement record to it: a channel post that boosted somebody else's post, and
 * a `Like` the channel left on somebody else's post.
 *
 * Each decrement is independently guarded on `$gt: 0`, mirroring the live
 * `Undo(Announce)` / unlike teardown, so a counter that already lags cannot
 * underflow. `stats.federatedBoostsCount` is deliberately untouched: it counts
 * inbound Announces, and a channel is a local author.
 */
async function repairSurvivingCounters(
  targets: DeletionTargets,
  dryRun: boolean,
): Promise<{ boostCounters: number; likeCounters: number }> {
  let boostCounters = 0;
  let likeCounters = 0;

  for (const originalId of targets.boostedOriginalIds) {
    boostCounters += await decrementStat(originalId, 'stats.boostsCount', dryRun);
  }
  for (const postId of targets.likedPostIds) {
    likeCounters += await decrementStat(postId, 'stats.likesCount', dryRun);
  }

  return { boostCounters, likeCounters };
}

/**
 * One guarded decrement. A failure is LOGGED and swallowed rather than thrown,
 * which is the opposite of every other step here and deliberate: the ids being
 * repaired were derived from rows this run has already deleted, so a retry
 * computes an EMPTY repair set and can never make good on it. Failing the job
 * would therefore lose the deletion's success without saving the counter. A stale
 * denormalized count is reconcilable on its own
 * (`scripts/recomputeFederatedEngagement.ts`); a half-reported cascade is not.
 */
async function decrementStat(postId: string, path: string, dryRun: boolean): Promise<number> {
  const filter = { _id: postId, [path]: { $gt: 0 } };
  try {
    if (dryRun) {
      // Count the SAME predicate the live write uses, so the dry-run figure is not
      // an optimistic guess about a post that may no longer exist.
      return (await Post.countDocuments(filter)) > 0 ? 1 : 0;
    }
    const result = await Post.updateOne(filter, { $inc: { [path]: -1 } });
    return result.modifiedCount;
  } catch (error) {
    logger.error(`${LOG_PREFIX} could not repair ${path} on a surviving post`, error);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The account this was pointed at is not a channel, so nothing was read and
 * nothing was written.
 *
 * The message distinguishes the two causes ON PURPOSE, because the operator
 * response is not the same one: "resolved as personal" means the id is wrong and
 * the run must never be repeated as-is, while "could not be resolved" means Oxy
 * could not answer and the same command is worth retrying once identity is back.
 * A single "not a channel" message would make the second look like the first, and
 * the natural reaction to the first — go and find the right id — is exactly the
 * wrong reaction to the second.
 */
export class NotAChannelAccountError extends Error {
  /** The kind Oxy answered with, or `null` when the read produced no answer. */
  readonly resolvedKind: AccountKind | null;

  constructor(oxyUserId: string, resolvedKind: AccountKind | null) {
    super(
      resolvedKind === null
        ? `${LOG_PREFIX} refused: the Oxy account kind of ${oxyUserId} could not be resolved, and ` +
            'deleting an account whose kind is unknown is not a risk this takes'
        : `${LOG_PREFIX} refused: ${oxyUserId} resolved as ${resolvedKind}, not a channel`,
    );
    this.name = 'NotAChannelAccountError';
    this.resolvedKind = resolvedKind;
  }
}

/**
 * Refuse anything that is not a channel, before a single row is read.
 *
 * `resolveAccountKind` is fail-soft to `null` by design — the reply gate needs an
 * identity outage not to refuse every reply on the site — so the DECISION is the
 * caller's, and here it is no. The two directions are not comparable: refusing
 * delays an administrative action that can be re-run, while allowing destroys a
 * person's posts irreversibly if the id turns out to name a personal account.
 *
 * The `catch` is deliberate belt-and-braces rather than dead code: the fail-soft
 * contract lives in another module and could be tightened there without anybody
 * looking at this call site, and a rejection that propagated would abort the run
 * with an error that says nothing about why.
 */
async function assertChannelAccount(oxyUserId: string): Promise<void> {
  let kind: AccountKind | null;
  try {
    kind = await resolveAccountKind(oxyUserId);
  } catch (error) {
    logger.error(`${LOG_PREFIX} could not resolve the account kind`, error);
    throw new NotAChannelAccountError(oxyUserId, null);
  }
  if (kind !== 'channel') {
    logger.warn(`${LOG_PREFIX} refused a deletion for a non-channel account`, {
      oxyUserId,
      resolvedKind: kind,
    });
    throw new NotAChannelAccountError(oxyUserId, kind);
  }
}

export interface ChannelDeletionPreview {
  channelOxyUserId: string;
  /** The channel's own posts. */
  posts: number;
  /** Other people's boosts of them, which are destroyed alongside. */
  boostsByOthers: number;
  /** Other people's replies into the set. A channel cannot be replied to, so 0. */
  replies: number;
  /** Other people's quotes of a doomed post: kept, pointer cleared. */
  quotesByOthersKept: number;
  /** Remote inboxes the `Delete(actor)` will reach. */
  federatedFollowers: number;
}

function buildPreview(targets: DeletionTargets): ChannelDeletionPreview {
  return {
    channelOxyUserId: targets.channelOxyUserId,
    posts: targets.channelPostIds.length,
    boostsByOthers: targets.boostPostIds.length,
    replies: targets.repliesByOthers,
    quotesByOthersKept: targets.quotesByOthersKept,
    federatedFollowers: targets.federatedFollowers,
  };
}

/**
 * What deleting this channel would cost, without touching anything.
 *
 * Gated on the account kind exactly like the deletion itself: a preview of "every
 * post this person has ever written" is not a harmless read to hand back for an
 * account nobody established is a channel.
 *
 * `replies` should always be 0 — the reply gate refuses a `channel` author at
 * five sites — and a non-zero value is a finding, not a number to accept.
 */
export async function previewChannelDeletion(
  channelOxyUserId: string,
): Promise<ChannelDeletionPreview> {
  await assertChannelAccount(channelOxyUserId);
  return buildPreview(await resolveDeletionTargets(channelOxyUserId));
}

export interface ChannelDeletionResult {
  /**
   * Affected-row counts for the steps THIS service executed, keyed EXACTLY
   * `${step.model}.${step.field}`.
   *
   * A key whose column is classified under two scopes (`Notification.entityId`,
   * `ContentLabel.targetId`) appears here when EITHER scope runs locally, and the
   * count is that local work only — the other scope's disposition is on its
   * manifest entry.
   */
  steps: Record<string, number>;
  /**
   * Manifest keys whose disposition belongs to
   * `PostDeletionCascade.cascadePostReferences`. Listed without a count on
   * purpose: the delegate reports failed legs, not per-reference totals, and
   * inventing a `0` here would be indistinguishable from a step that never ran.
   */
  delegated: string[];
  /** Manifest keys deliberately KEPT — see each entry's `why` for the reason. */
  retained: string[];
  preview: ChannelDeletionPreview;
  dryRun: boolean;
}

/**
 * Destroy one channel's content and every Mention row pointing at it.
 *
 * The order below is the whole design; each phase says what a crash inside it
 * leaves behind, and none of those states is unrecoverable by a re-run.
 */
export async function deleteChannelContent(
  channelOxyUserId: string,
  options: { dryRun: boolean },
): Promise<ChannelDeletionResult> {
  const { dryRun } = options;

  // 0. Refuse anything that is not a channel, before any read of the post set and
  //    long before any write or federation call. Pointed at a personal account
  //    this destroys a person's writing, and no route existing today is the
  //    absence of an accident rather than a defence against one.
  await assertChannelAccount(channelOxyUserId);

  const run = new CascadeRun();
  const schedule = buildSchedule(run);

  // 1. Resolve every id set ONCE, read-only. A crash here has changed nothing.
  const targets = await resolveDeletionTargets(channelOxyUserId);
  const preview = buildPreview(targets);
  logger.info(`${LOG_PREFIX} resolved deletion targets`, {
    dryRun,
    posts: preview.posts,
    boostsByOthers: preview.boostsByOthers,
    replies: preview.replies,
    quotesByOthersKept: preview.quotesByOthersKept,
    federatedFollowers: preview.federatedFollowers,
  });

  // 2. Drain the channel's undelivered outbound activities. The manifest requires
  //    this BEFORE the actor Delete, or a queued Create races it and republishes a
  //    post on the receiving instance. A crash here leaves some queued activities
  //    that a re-run drains; nothing has been told the channel is gone yet.
  await runPhase('federation-drain', schedule, targets, dryRun, run);

  // 3. Prove the deletion cannot strand a reference nobody cleans. Read-only, and
  //    deliberately BEFORE the broadcast rather than after it: a refusal here is
  //    permanent until an operator acts, and broadcasting first would leave remote
  //    servers holding a Tombstone for posts that are still live locally, on every
  //    retry. It runs in a dry run too, so a blocker surfaces before a live run.
  await assertPostsSafeToDelete(`channelDeletion:${channelOxyUserId}`, targets.deletionTargets, {
    removedByCascade: REMOVED_BY_CASCADE,
    // Stated separately from the claim above because it is the opposite kind of
    // statement: these rows are kept on purpose, so the residue check must not
    // demand their absence. See the constants at the top of this file.
    keptByPolicy: KEPT_BY_POLICY,
    // The graph probe would otherwise refuse the run for the quotes and replies
    // this cascade UNSETS in phase 6 — a strictly stronger disposition than the
    // dangling pointer the allowance describes. `boostOf` stays covered, and the
    // boost closure resolved in phase 1 is what keeps it satisfied.
    allowDanglingReplyReferences: true,
  });

  // 4. Tell the fediverse. Nothing delivery reads has been deleted yet. A crash
  //    here leaves an actor that remote servers may already have dropped while its
  //    local rows survive — a re-run re-sends (Delete is idempotent remotely) and
  //    completes the cascade.
  if (!dryRun) {
    await broadcastFederatedDelete(targets);
  }

  // 5. Rows that exist only as an attachment to a doomed post. A crash here leaves
  //    posts alive with some of their engagement gone: visible as under-counted
  //    rows, converged by a re-run.
  //
  //    Most of this phase is the DELEGATE's: `cascadePostReferences` is the live
  //    delete route's own implementation of these dispositions, handed the whole
  //    doomed set at once. A failed leg is recorded so the run still throws and a
  //    BullMQ retry re-runs it — the reason that entry point exists separately from
  //    the never-throwing one the delete route calls. Skipped in a dry run: it
  //    deletes, and counting it instead would mean writing the queries again here,
  //    which is the duplication the delegation removes.
  if (!dryRun) {
    const { failedLegs } = await cascadePostReferences(targets.doomedRows);
    for (const leg of failedLegs) run.failDelegated(leg);
  }
  //    The rest is local: the references the preflight has no probe for, so the
  //    delegate has no leg for them either.
  await runPhase('post-dependents', schedule, targets, dryRun, run);

  // 6. Other people's posts that point INTO the doomed set. Their content is kept;
  //    only the pointer goes. A crash here leaves a mix of scrubbed and dangling
  //    pointers, which hydration already tolerates until the re-run.
  await runPhase('scrub-foreign-posts', schedule, targets, dryRun, run);

  // 7. The doomed rows: the boosts first (they render entirely from an original
  //    that is about to disappear), then the channel's own posts. A crash here is
  //    the first point at which content is actually gone, and everything that
  //    pointed at it has already been swept.
  await runPhase('doomed-posts', schedule, targets, dryRun, run);

  // 8. Lane rows, then the account-keyed rows. The lane ids were captured in phase
  //    1, so deleting the lanes after the mutes cannot orphan either.
  await runPhase('lanes', schedule, targets, dryRun, run);
  await runPhase('account', schedule, targets, dryRun, run);

  // 9. Counters on posts that SURVIVE but lost an engagement record. Deliberately
  //    not part of `steps`: no manifest entry describes a counter, and inventing a
  //    key would break the set equality that binds this file to the manifest.
  //
  //    NOT duplicated with the delegate: `cascadePostReferences` runs the reference
  //    legs only — `PostDeletionCascade`'s own counter repair belongs to
  //    `cascadeDeletedPost`, which this never calls — because which rows survive
  //    depends on which posts the caller is destroying, and only the caller knows
  //    that.
  const counters = await repairSurvivingCounters(targets, dryRun);
  logger.info(`${LOG_PREFIX} repaired counters on surviving posts`, {
    dryRun,
    boostCounters: counters.boostCounters,
    likeCounters: counters.likeCounters,
  });

  // 10. Verify what the cascade CLAIMED to remove actually went — the `cascade`
  //     half only, never the retained half, whose absence would be the bug.
  //     Skipped in a dry run, where every claim is trivially unmet because nothing
  //     was deleted.
  if (!dryRun) {
    const residue = await collectPostCascadeResidue(targets.deletionTargets, REMOVED_BY_CASCADE);
    if (residue.length > 0) {
      logger.error(
        `${LOG_PREFIX} cascade claimed references it did not remove: ${residue.join(', ')}`,
      );
    }
  }

  if (run.failures.length > 0) {
    throw new Error(
      `${LOG_PREFIX} ${run.failures.length} cascade step(s) failed for ${channelOxyUserId} ` +
        `(${run.failures.join(', ')}) — the run will be retried against whatever survived`,
    );
  }

  const { delegated, retained } = run.classify();
  return { steps: run.steps, delegated, retained, preview, dryRun };
}
