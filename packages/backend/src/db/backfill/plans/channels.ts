/**
 * Channels and lanes: `channels` `channelmembers` `channelfollows` `lanes`
 * `lanemutes`.
 *
 * Five collections that arrived from `main` DURING this migration, in the same
 * merge that added `posts.lane_id` and `posts.channel_id`. The completeness gate
 * (`__tests__/db/backfillTableCoverage.test.ts`) is what surfaced them, which is
 * the third time it has done so — `trend_summaries` and `trend_graphs` were the
 * first two, and all three arrived the same way. A merge from `main` is the
 * shape that produces an unfed table, not an oversight in the original
 * inventory.
 *
 * ## The two derived identity columns are copied, never re-derived
 *
 * `channels.handle_lower` and `lanes.name_lower` are what the unique indexes are
 * built on, and Mongo derived them in a `pre('validate')` hook. The backfill
 * READS the stored value rather than re-normalizing: a document written by an
 * older revision of the hook must migrate as the value the unique index was
 * actually built over, or a re-derivation that disagrees turns a legitimate row
 * into a constraint violation — or worse, silently splits two rows that Mongo
 * considered one identity. `reqStr` therefore refuses a document missing one,
 * rather than filling it in.
 *
 * ## Counters get numeric audits; `lanes` has none to audit
 *
 * `channels.follower_count` / `member_count` / `post_count` are `$inc`-driven in
 * Mongo, where a decrement race could take one negative and nothing would
 * notice. The CHECK here rejects that, so each is audited — the same class the
 * discovery plans document at length. `lanes` deliberately carries no counter
 * (nothing ranks lanes), so there is nothing to audit and no absence to explain.
 */

import {
  channelFollows,
  channelMembers,
  channels,
  laneMutes,
  lanes,
} from '../../schema/channels';
import type { CollectionPlan } from '../plan';
import type { ResolutionContext } from '../resolutions';
import { DERIVE_LANE_OWNER_TYPE } from '../resolutions';
import type { MongoDocument } from '../values';
import { buildRow } from '../rowBuilder';
import { bool, id, int, ownId, reqStr, str } from '../values';
import { optionalDate, timestamps } from './timestamps';

/** `channels` → `channels`. */
const channelsPlan: CollectionPlan = {
  collection: 'channels',
  table: channels,
  enumAudits: [{ path: 'visibility', column: channels.visibility, absentAs: 'public' }],
  numericAudits: [
    {
      path: 'followerCount',
      column: channels.followerCount,
      constraint: 'channels_counts_check',
      min: 0,
      absentAs: 0,
    },
    {
      path: 'memberCount',
      column: channels.memberCount,
      constraint: 'channels_counts_check',
      min: 0,
      absentAs: 0,
    },
    {
      path: 'postCount',
      column: channels.postCount,
      constraint: 'channels_counts_check',
      min: 0,
      absentAs: 0,
    },
  ],
  uniquenessAudits: [
    // The channel's global identity and the `/c/<handle>` lookup. A duplicate
    // here means the source violated its own unique index.
    { index: 'channels_handle_lower_key', key: [{ path: 'handleLower', normalize: 'exact' }] },
  ],
  transform: (doc, emit) => {
    const rowId = ownId(doc);
    emit(
      channels,
      buildRow(
        channels,
        {
          id: rowId,
          handle: reqStr(doc, 'handle'),
          // Read, not re-derived — see the module docblock.
          handleLower: reqStr(doc, 'handleLower'),
          title: reqStr(doc, 'title'),
          description: str(doc, 'description'),
          // Bare Oxy file ids. Never URLs — media resolution is the SDK's
          // chokepoint — so they are copied verbatim with no rewriting.
          avatar: str(doc, 'avatar'),
          banner: str(doc, 'banner'),
          ownerOxyUserId: reqStr(doc, 'ownerOxyUserId'),
          visibility: str(doc, 'visibility') ?? 'public',
          signPosts: bool(doc, 'signPosts') ?? false,
          followerCount: int(doc, 'followerCount') ?? 0,
          memberCount: int(doc, 'memberCount') ?? 0,
          postCount: int(doc, 'postCount') ?? 0,
          ...timestamps(doc),
        },
        rowId
      )
    );
  },
};

/** `channelmembers` → `channel_members`. */
const channelMembersPlan: CollectionPlan = {
  collection: 'channelmembers',
  table: channelMembers,
  enumAudits: [
    { path: 'role', column: channelMembers.role, absentAs: 'publisher' },
    { path: 'status', column: channelMembers.status, absentAs: 'pending' },
  ],
  uniquenessAudits: [
    // The natural key: one membership per person per channel. It is what makes
    // an interrupted backfill converge rather than duplicate.
    {
      index: 'channel_members_channel_id_oxy_user_id_key',
      key: [
        { path: 'channelId', normalize: 'exact' },
        { path: 'oxyUserId', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    const rowId = ownId(doc);
    emit(
      channelMembers,
      buildRow(
        channelMembers,
        {
          id: rowId,
          channelId: reqStr(doc, 'channelId'),
          oxyUserId: reqStr(doc, 'oxyUserId'),
          role: str(doc, 'role') ?? 'publisher',
          status: str(doc, 'status') ?? 'pending',
          // Absent on the owner's own founding row, which is why this is `id()`
          // rather than `reqStr` — an owner's membership predates any invite.
          invitedByOxyUserId: id(doc, 'invitedByOxyUserId'),
          ...optionalDate(doc, 'invitedAt', 'invitedAt'),
          ...optionalDate(doc, 'respondedAt', 'respondedAt'),
          ...timestamps(doc),
        },
        rowId
      )
    );
  },
};

/** `channelfollows` → `channel_follows`. */
const channelFollowsPlan: CollectionPlan = {
  collection: 'channelfollows',
  table: channelFollows,
  uniquenessAudits: [
    {
      index: 'channel_follows_oxy_user_id_channel_id_key',
      key: [
        { path: 'oxyUserId', normalize: 'exact' },
        { path: 'channelId', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    const rowId = ownId(doc);
    emit(
      channelFollows,
      buildRow(
        channelFollows,
        {
          id: rowId,
          channelId: reqStr(doc, 'channelId'),
          oxyUserId: reqStr(doc, 'oxyUserId'),
          // A dedicated model exists precisely BECAUSE of this per-follow flag:
          // `EntityFollow` cannot express it. Defaulting a missing one to `true`
          // matches the model's own default.
          notify: bool(doc, 'notify') ?? true,
          ...timestamps(doc),
        },
        rowId
      )
    );
  },
};

/** `lanes` → `lanes`. */
/**
 * A lane's owner kind, derived for the documents the pre-pass answered.
 *
 * The DECISION belongs to {@link DERIVE_LANE_OWNER_TYPE} and is taken there,
 * against the whole source: whether a lane's absent `ownerType` is derivable at
 * all depends on the channel count, which is a fact about the COLLECTION and a
 * transform sees one document. Reading the pre-pass answer here — rather than
 * re-deciding from the document — is what keeps the audit, the copy and both
 * verifier passes from disagreeing about which lanes were answered.
 *
 * A lane the rule did not claim keeps `reqStr`, so it throws with the document
 * named rather than quietly acquiring a value: absent AND un-derivable is a
 * question for a human, and the audit already refuses the copy over it.
 */
function laneOwnerType(doc: MongoDocument, rowId: string, resolutions: ResolutionContext): string {
  if (resolutions.actedOn.get(DERIVE_LANE_OWNER_TYPE.id)?.has(rowId) !== true) {
    return reqStr(doc, 'ownerType');
  }
  const ownerId = reqStr(doc, 'ownerId');
  resolutions.record({
    rule: DERIVE_LANE_OWNER_TYPE,
    documentId: rowId,
    detail:
      "ownerType was absent and is copied as 'user' — the source holds no " +
      'channel, so no lane in it can be channel-owned and one possibility ' +
      'remains.',
    // The id whose KIND was inferred. Nothing else records what this lane was
    // taken to be, so it is what a later reader would need to check the call.
    evidence: { 'lanes.ownerId': ownerId, 'lanes.ownerType (written)': 'user' },
  });
  return 'user';
}

const lanesPlan: CollectionPlan = {
  collection: 'lanes',
  table: lanes,
  enumAudits: [
    // NOT `absentAs`. The substitute is derivable only while the source holds no
    // channel, so it is a rule that re-measures its own premise rather than a
    // declared default that would keep answering after the premise expires —
    // see {@link DERIVE_LANE_OWNER_TYPE}.
    { path: 'ownerType', column: lanes.ownerType, resolvedBy: DERIVE_LANE_OWNER_TYPE },
    { path: 'displayMode', column: lanes.displayMode, absentAs: 'mixed' },
  ],
  uniquenessAudits: [
    // Uniqueness is per PUBLISHER, which is why `ownerType` is in the key: a
    // user and a channel may hold the same lane name.
    {
      index: 'lanes_owner_name_lower_key',
      key: [
        { path: 'ownerType', normalize: 'exact' },
        { path: 'ownerId', normalize: 'exact' },
        { path: 'nameLower', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit, resolutions) => {
    const rowId = ownId(doc);
    emit(
      lanes,
      buildRow(
        lanes,
        {
          id: rowId,
          ownerType: laneOwnerType(doc, rowId, resolutions),
          // POLYMORPHIC — an Oxy account id or a `channels.id`, discriminated by
          // `ownerType`. No foreign key, for the reason recorded in
          // `schema/deferredForeignKeys.ts`.
          ownerId: reqStr(doc, 'ownerId'),
          name: reqStr(doc, 'name'),
          // Read, not re-derived — see the module docblock.
          nameLower: reqStr(doc, 'nameLower'),
          displayMode: str(doc, 'displayMode') ?? 'mixed',
          ...timestamps(doc),
        },
        rowId
      )
    );
  },
};

/** `lanemutes` → `lane_mutes`. */
const laneMutesPlan: CollectionPlan = {
  collection: 'lanemutes',
  table: laneMutes,
  uniquenessAudits: [
    {
      index: 'lane_mutes_viewer_lane_key',
      key: [
        { path: 'viewerOxyUserId', normalize: 'exact' },
        { path: 'laneId', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    const rowId = ownId(doc);
    emit(
      laneMutes,
      buildRow(
        laneMutes,
        {
          id: rowId,
          viewerOxyUserId: reqStr(doc, 'viewerOxyUserId'),
          laneId: reqStr(doc, 'laneId'),
          // DENORMALIZED from the lane's publisher so the settings screen groups
          // a viewer's mutes with no join. Required in the target, so a document
          // missing it is refused rather than written as an empty string — a
          // blank publisher would silently group every such mute together.
          laneOwnerOxyUserId: reqStr(doc, 'laneOwnerOxyUserId'),
          ...timestamps(doc),
        },
        rowId
      )
    );
  },
};

export const CHANNEL_PLANS: readonly CollectionPlan[] = [
  channelsPlan,
  channelMembersPlan,
  channelFollowsPlan,
  lanesPlan,
  laneMutesPlan,
];
