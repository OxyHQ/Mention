/**
 * Id-Shaped Columns That Carry No Foreign Key
 *
 * Two lists, one purpose: between them and the real `.references()` constraints,
 * EVERY id-shaped column in this schema is classified — which is what lets
 * `__tests__/foreignKeys.test.ts` fail on a NEW one nobody decided about.
 *
 * `DEFERRED_FOREIGN_KEYS` is the TEMPORARY list: a constraint that is decided
 * but not yet expressible because drizzle cannot write a forward reference. The
 * test turns it into a gate — the moment the parent table appears in the barrel,
 * the run goes red naming every column that must now reference it. An empty
 * ledger is the finish line, and it is empty today because Mention's schema
 * landed in one pass.
 *
 * `ID_COLUMNS_WITHOUT_FOREIGN_KEY` is the PERMANENT counterpart, and in Mention
 * it is long for one structural reason: **there is no `users` table.** Oxy owns
 * identity, Mention reaches it over HTTP, and every `oxy_user_id` /`user_id` /
 * `actor_id` / `owner_oxy_user_id` in this schema is therefore a foreign
 * SERVICE's primary key. None of them can carry a constraint, and pretending
 * otherwise would mean either inventing a shadow `users` table (a cache that can
 * disagree with Oxy) or blocking every write on an HTTP round trip.
 *
 * Rather than enumerate several hundred identical entries, the Oxy-account
 * columns are classified by the PREDICATE below and each remaining entry is
 * listed individually with its own reason.
 */

import type { PgColumn, PgTable, UpdateDeleteAction } from 'drizzle-orm/pg-core';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { sqlColumnName } from '../casing';
import { entityFollows } from './engagement';
import { actorKeyPairs, federatedActors, federatedMediaCache } from './federation';
import { channelMembers, laneMutes, lanes } from './channels';
import { gifs } from './discovery';
import {
  contentLabels,
  moderationEnforcements,
  moderationEvents,
  moderationOutbox,
  reports,
} from './moderation';
import { customFeedTopics, feedInteractions } from './feeds';
import { federatedFollows } from './federation';
import { mentionNodeIngestWitnesses, mentionRepoHeads, mentionSignedRecords } from './mtn';
import { notifications, pushTokens, topicStats, trending } from './discovery';
import { postgates, threadgateAllowRules, threadgates } from './gates';
import { endorsementOutbox, engagementOutbox } from './outbox';
import {
  postAttachments,
  postClassificationTopicRefs,
  postMedia,
  postVariantAltTexts,
  postVariantMedia,
} from './postContent';
import { posts } from './posts';
import { userBehaviorTopics, userSettings, userSettingsLabelActions } from './userProfile';

/** A foreign key that is decided but not yet expressible. */
export interface DeferredForeignKey {
  readonly table: PgTable;
  readonly column: PgColumn;
  /** SQL name of the parent table, e.g. `posts`. */
  readonly parentTable: string;
  /** Column on the parent, e.g. `id`. */
  readonly parentColumn: string;
  /** Decided per relation — never left to default. */
  readonly onDelete: UpdateDeleteAction;
  /** Why that `ON DELETE`, in one line. */
  readonly reason: string;
}

/** An id-shaped column that will never carry a foreign key. */
export interface IdColumnWithoutForeignKey {
  readonly table: PgTable;
  readonly column: PgColumn;
  readonly reason: string;
}

/**
 * Empty, and that is the finish line rather than an oversight: Mention's tables
 * all landed in one pass, so every relation that CAN be a constraint already is
 * one. A new table added ahead of its parent goes here with its `ON DELETE` and
 * reason already decided.
 */
export const DEFERRED_FOREIGN_KEYS: readonly DeferredForeignKey[] = [];

/**
 * The SQL names of columns holding an OXY ACCOUNT id.
 *
 * A column named by any of these is a reference into Oxy's user table, reached
 * over HTTP, and can never carry a local constraint. Listed as a predicate
 * rather than several hundred individual entries because the reason is
 * identical for every one of them and repeating it would bury the entries that
 * have their own.
 */
const OXY_ACCOUNT_COLUMN_NAMES: ReadonlySet<string> = new Set([
  'oxy_user_id',
  'user_id',
  'owner_oxy_user_id',
  'local_user_id',
  'sender_oxy_user_id',
  'actor_id',
  'author_id',
  'recipient_id',
  'subscriber_id',
  'reviewer_id',
  'reporter',
  'creator_id',
  'created_by',
  'poker_id',
  'poked_id',
  'muted_id',
  'blocked_id',
  'payload_actor_oxy_user_id',
  'payload_post_owner_oxy_user_id',
  'pending_remove_owner_id',
]);

/**
 * True when `column` holds an Oxy account id.
 *
 * Uses `sqlColumnName`, never `column.name`: the latter is the TypeScript
 * PROPERTY name (`oxyUserId`), so a set of snake_case names compared against it
 * would match NOTHING and this predicate would answer `false` for every column
 * while looking perfectly correct.
 */
export function isOxyAccountColumn(column: PgColumn): boolean {
  return OXY_ACCOUNT_COLUMN_NAMES.has(sqlColumnName(column));
}

/**
 * Every id-shaped column that is NOT an Oxy account id and still carries no
 * foreign key. Each has its own reason; none of them is "we forgot".
 */
export const ID_COLUMNS_WITHOUT_FOREIGN_KEY: readonly IdColumnWithoutForeignKey[] = [
  {
    table: channelMembers,
    column: channelMembers.invitedByOxyUserId,
    reason:
      'The Oxy account that sent the invite. An Oxy account id like every ' +
      'other, and it is listed here only because the name is not one the ' +
      'predicate recognizes — there is no users table for it to point at.',
  },
  {
    table: lanes,
    column: lanes.ownerId,
    reason:
      'POLYMORPHIC: an Oxy account id when `owner_type` is `user`, a ' +
      '`channels.id` when it is `channel`. A constraint can name only one ' +
      'target, and half of the values point at a service Postgres cannot see ' +
      'anyway. The polymorphism is deliberate — it is what lets a channel own a ' +
      'lane with no migration — and `owner_type` is the discriminator every ' +
      'reader branches on.',
  },
  {
    table: laneMutes,
    column: laneMutes.viewerOxyUserId,
    reason:
      'The reader who muted the lane. An Oxy account id; see the module ' +
      'docblock for why no id-shaped Oxy column can carry a constraint.',
  },
  {
    table: laneMutes,
    column: laneMutes.laneOwnerOxyUserId,
    reason:
      'DENORMALIZED from the lane\'s publisher so the settings screen can group ' +
      'a viewer\'s mutes by publisher with no join. An Oxy account id when the ' +
      'lane belongs to a user; it follows `lanes.owner_id`, which is itself ' +
      'polymorphic and unconstrainable for the reason stated above.',
  },
  {
    table: trending,
    column: trending.actorIds,
    reason:
      'A SAMPLE of the Oxy accounts behind a trend — evidence that real people ' +
      'are posting, not a relation. It is an array rather than a join table for ' +
      'the same reason: nothing ever queries a trend BY actor, and there is no ' +
      'users table for the ids to point at.',
  },
  {
    table: gifs,
    column: gifs.klipyId,
    reason:
      'The GIF provider\'s own id (Klipy\'s numeric id, stringified). A third ' +
      'party\'s key, used here purely as the dedup key.',
  },
  {
    table: gifs,
    column: gifs.mp4FileId,
    reason: 'An Oxy S3 file id. Oxy owns files; there is no local table.',
  },
  {
    table: gifs,
    column: gifs.previewFileId,
    reason: 'An Oxy S3 file id for the small mp4 preview. Oxy owns files.',
  },
  {
    table: federatedMediaCache,
    column: federatedMediaCache.oxyFileId,
    reason: 'An Oxy S3 file id for the cached media bytes. Oxy owns files.',
  },
  {
    table: federatedMediaCache,
    column: federatedMediaCache.posterFileId,
    reason: 'An Oxy S3 file id for the extracted video poster frame.',
  },
  {
    table: actorKeyPairs,
    column: actorKeyPairs.keyId,
    reason:
      'The ActivityPub `keyId` URI advertised to remote instances ' +
      '(`https://<domain>/ap/users/<name>#main-key`). A URI, not a row id.',
  },
  {
    table: federatedActors,
    column: federatedActors.publicKeyId,
    reason:
      'The REMOTE actor\'s advertised `keyId` URI, resolved during HTTP-signature ' +
      'verification. It names a key on someone else\'s server.',
  },
  {
    table: posts,
    column: posts.federationActivityId,
    reason:
      'The inbound ActivityPub activity URI. A remote instance\'s identifier for ' +
      'the activity, unique here only as a dedup key.',
  },
  {
    table: reports,
    column: reports.crowdSourceReportId,
    reason: 'CrowdSource\'s id for the report it accepted. A third party\'s key.',
  },
  {
    table: reports,
    column: reports.crowdSourceCaseId,
    reason: 'CrowdSource owns cases; Mention stores the id it was told.',
  },
  {
    table: reports,
    column: reports.decisionId,
    reason: 'CrowdSource\'s id for a published decision. A third party\'s key.',
  },
  {
    table: moderationOutbox,
    column: moderationOutbox.payloadEventId,
    reason:
      'The inbound webhook event id. It matches `moderation_events.id`, but the ' +
      'outbox row is written from the webhook payload BEFORE the event row is ' +
      'guaranteed durable, so a constraint would invert the ordering §10.8 needs.',
  },
  {
    table: moderationOutbox,
    column: moderationOutbox.payloadCaseId,
    reason: 'CrowdSource\'s case id.',
  },
  {
    table: moderationEvents,
    column: moderationEvents.caseId,
    reason: 'CrowdSource\'s case id.',
  },
  {
    table: moderationEnforcements,
    column: moderationEnforcements.decisionId,
    reason: 'CrowdSource\'s decision id — half of Appendix D\'s idempotency key.',
  },
  {
    table: moderationEnforcements,
    column: moderationEnforcements.caseId,
    reason: 'CrowdSource\'s case id.',
  },
  {
    table: mentionRepoHeads,
    column: mentionRepoHeads.headRecordId,
    reason:
      'The head record\'s CONTENT ADDRESS, not its row id. It is advanced in the ' +
      'same transaction as the record insert, so a constraint would only ' +
      'restate an ordering the writer already guarantees — and a conflict ' +
      'archive deliberately keeps a head whose target is no longer canonical.',
  },
  {
    table: mentionNodeIngestWitnesses,
    column: mentionNodeIngestWitnesses.recordId,
    reason:
      'The content address Mention witnessed. The witness must OUTLIVE the ' +
      'record it attests to — that is the whole point of an independent ' +
      'attestation against a silently rewritten history.',
  },
  {
    table: engagementOutbox,
    column: engagementOutbox.payloadRelationshipId,
    reason:
      'A `likes.id` OR a `bookmarks.id`, by `kind`. Polymorphic — and an UNLIKE ' +
      'event names a row the same transaction just deleted, so a constraint ' +
      'would make the event unrecordable.',
  },
  {
    table: engagementOutbox,
    column: engagementOutbox.payloadFederationActivityId,
    reason: 'An ActivityPub activity URI to Undo, held by a remote instance.',
  },
  {
    table: endorsementOutbox,
    column: endorsementOutbox.pendingRemoveMemberIds,
    reason:
      'A transient batch of OXY ACCOUNT ids captured before members were pruned, ' +
      'read whole and cleared whole on the next successful push.',
  },
  {
    table: postMedia,
    column: postMedia.mediaId,
    reason:
      'A media handle that is EITHER an Oxy S3 file id OR a raw remote URL for ' +
      'federated media the cache has not rewritten yet. Two id spaces in one ' +
      'column, neither of them a row in this database — Oxy owns files.',
  },
  {
    table: postVariantMedia,
    column: postVariantMedia.mediaId,
    reason: 'Same two id spaces as `post_media.media_id`.',
  },
  {
    table: postVariantAltTexts,
    column: postVariantAltTexts.mediaId,
    reason:
      'The `post_media.media_id` this alt text describes — a media HANDLE, not a ' +
      'row id, so it cannot reference `post_media.id` either.',
  },
  {
    table: postAttachments,
    column: postAttachments.attachmentId,
    reason:
      'Polymorphic by `type`: a media handle for `media`, absent for every other ' +
      'attachment kind (which are markers, not references).',
  },
  {
    table: userSettings,
    column: userSettings.profileMediaSyraTrackId,
    reason: 'A Syra catalog track id. Syra owns the catalog.',
  },
  {
    table: userSettings,
    column: userSettings.profileMediaSyraPodcastId,
    reason: 'A Syra catalog podcast-show id.',
  },
  {
    table: posts,
    column: posts.contentPollId,
    reason:
      '`polls.post_id` is the owning side and carries the constraint. This is ' +
      'the denormalized read shortcut; a second constraint in the opposite ' +
      'direction would make creating either row impossible without the other.',
  },
  {
    table: posts,
    column: posts.contentArticleId,
    reason: 'Same as `content_poll_id`: `articles.post_id` is the owning side.',
  },
  {
    table: posts,
    column: posts.contentEventId,
    reason: 'An event id from an external calendar integration. No local table.',
  },
  {
    table: posts,
    column: posts.contentRoomId,
    reason:
      'A Syra live-room id. Syra owns rooms and Mention persists no Room ' +
      'document — the reason a live room has no CrowdSource subject provider ' +
      'either.',
  },
  {
    table: posts,
    column: posts.contentPodcastSyraId,
    reason: 'A Syra podcast-show id. Syra owns the catalog.',
  },
  {
    table: entityFollows,
    column: entityFollows.entityId,
    reason:
      'Polymorphic by `entity_type`: a hashtag STRING for `hashtag`, an ' +
      '`account_lists.id` for `list`. A single column cannot reference two ' +
      'things, and a hashtag references nothing at all.',
  },
  {
    table: notifications,
    column: notifications.entityId,
    reason:
      'Polymorphic by `entity_type`: a `posts.id` for `post`/`reply`, an Oxy ' +
      'account id for `profile`. `deletePost` already deletes these by hand.',
  },
  {
    table: reports,
    column: reports.reportedId,
    reason:
      'Polymorphic by `reported_type` across five nouns, two of which ' +
      '(`message`, `room`) Mention does not even persist.',
  },
  {
    table: moderationEnforcements,
    column: moderationEnforcements.subjectId,
    reason: 'Polymorphic by `subject_type` — Mention\'s own noun, not a fixed table.',
  },
  {
    table: contentLabels,
    column: contentLabels.targetId,
    reason: 'Polymorphic by `target_type`: a `posts.id` or an Oxy account id.',
  },
  {
    table: threadgates,
    column: threadgates.postId,
    reason:
      'The gate is upserted from a client-supplied post id without first ' +
      'proving the post exists, so a constraint would turn a race into a 500 ' +
      'on a path that today degrades to "no gate".',
  },
  {
    table: postgates,
    column: postgates.postId,
    reason: 'Same as `threadgates.post_id`.',
  },
  {
    table: threadgateAllowRules,
    column: threadgateAllowRules.listId,
    reason:
      'An `account_lists.id` authored from a client payload. A deleted list ' +
      'must degrade to "matches nobody", not to a failed rule evaluation.',
  },
  {
    table: feedInteractions,
    column: feedInteractions.postUri,
    reason:
      'A CLIENT-SUPPLIED post id (the name says URI; the tracker\'s own comment ' +
      'says it is the id). A forged value must produce no row rather than a ' +
      'constraint error on a telemetry write.',
  },
  {
    table: federatedFollows,
    column: federatedFollows.remoteActorUri,
    reason:
      'A remote actor URI/DID. An inbound Follow arrives for an actor Mention ' +
      'may not have fetched yet, so it cannot reference `federated_actors`.',
  },
  {
    table: federatedFollows,
    column: federatedFollows.activityId,
    reason:
      'A published ActivityPub Follow URI held by remote servers. It EMBEDS a ' +
      '`federated_actors.id` but is not one.',
  },
  {
    table: mentionSignedRecords,
    column: mentionSignedRecords.recordId,
    reason: 'A content address (sha256 of the signing input), not a row id.',
  },
  {
    table: mentionSignedRecords,
    column: mentionSignedRecords.prev,
    reason:
      'The PREVIOUS record\'s content address. It chains to another row in this ' +
      'table, but by content hash rather than by primary key — and a conflict ' +
      'archive deliberately keeps a `prev` whose target is not canonical.',
  },
  {
    table: mentionSignedRecords,
    column: mentionSignedRecords.idempotencyKey,
    reason: 'A producer-event identity minted by the outbox. Not a row id.',
  },
  {
    table: mentionSignedRecords,
    column: mentionSignedRecords.rkey,
    reason:
      'A Mongo `_id` INSIDE a signed envelope. It usually names a `posts.id`, ' +
      'but it also names a `likes.id` or a `bookmarks.id` depending on `nsid`, ' +
      'and a record must survive the deletion of what it describes — that is ' +
      'what a tombstone is for.',
  },
  {
    table: postClassificationTopicRefs,
    column: postClassificationTopicRefs.topicId,
    reason: 'An Oxy Topic-registry id. The registry lives in Oxy; there is no local table.',
  },
  {
    table: customFeedTopics,
    column: customFeedTopics.topicId,
    reason: 'An Oxy Topic-registry id. Mongo typed it `ref: \'Topic\'`; no such collection exists here.',
  },
  {
    table: userBehaviorTopics,
    column: userBehaviorTopics.topicId,
    reason: 'An Oxy Topic-registry id.',
  },
  {
    table: topicStats,
    column: topicStats.topicId,
    reason: 'An Oxy Topic-registry id.',
  },
  {
    table: trending,
    column: trending.topicId,
    reason: 'An Oxy Topic-registry id.',
  },
  {
    table: userSettingsLabelActions,
    column: userSettingsLabelActions.labelerId,
    reason:
      'A `labelers.id` stored as a raw string. `LabelService` already tolerates ' +
      'a labeler that no longer resolves; a constraint would turn a deleted ' +
      'labeler into a failed settings WRITE instead of an ignored preference.',
  },
  {
    table: endorsementOutbox,
    column: endorsementOutbox.sourceId,
    reason:
      'Polymorphic by `source`: a `starter_packs.id` or an `account_lists.id`.',
  },
  {
    table: pushTokens,
    column: pushTokens.deviceId,
    reason: 'A client-supplied device id. Not the primary key of any row.',
  },
];

/**
 * Every `*_id`-shaped column in a table, by SQL name.
 *
 * Deliberately matches on the SQL name (via `sqlColumnName`) rather than the
 * property name, for the reason spelled out on `isOxyAccountColumn`.
 */
export function idShapedColumns(table: PgTable): PgColumn[] {
  return Object.values(getTableColumns(table)).filter((column) => {
    const name = sqlColumnName(column);
    return name === 'id' ? false : name.endsWith('_id') || name.endsWith('_ids');
  });
}

/** A stable `table.column` label, for a test failure message. */
export function columnLabel(column: PgColumn): string {
  return `${getTableName(column.table)}.${sqlColumnName(column)}`;
}
