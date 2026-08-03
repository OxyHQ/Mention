/**
 * Lanes: `lanes` `lanemutes`.
 *
 * This file fed FIVE collections until `0017_a_channel_is_an_account` retired
 * the Mention-local channel. A channel is an Oxy ACCOUNT now, so `channels`,
 * `channelmembers` and `channelfollows` have no target table to be copied into —
 * `0017` drops all three, along with `posts.channel_id` and `lanes.owner_type` —
 * and their plans are deleted rather than left pointing at absent tables.
 *
 * **Deleting a plan is normally how a table silently goes unfed**, which is why
 * this is safe only in the same breath as the migration: the completeness gate
 * (`__tests__/db/backfillTableCoverage.test.ts`) compares the plans against the
 * SCHEMA, so a plan removed while its table still existed would fail it, and a
 * table dropped while its plan survived fails at module load instead — which is
 * exactly what happened here, taking 32 test files down at import. The plans and
 * the migration have to be true in one branch state; neither half is correct
 * alone.
 *
 * What that costs was MEASURED, not assumed, and `0017` records it: against
 * production Mongo the three collections do not exist, they copied ZERO rows,
 * and 0 of 596,309 posts carry a `channelId`. So nothing that was ever written
 * stops being copied.
 *
 * ## The derived identity column is copied, never re-derived
 *
 * `lanes.name_lower` is what the unique index is built on, and Mongo derived it
 * in a `pre('validate')` hook. The backfill READS the stored value rather than
 * re-normalizing: a document written by an older revision of the hook must
 * migrate as the value the unique index was actually built over, or a
 * re-derivation that disagrees turns a legitimate row into a constraint
 * violation — or worse, silently splits two rows that Mongo considered one
 * identity. `reqStr` therefore refuses a document missing one, rather than
 * filling it in.
 *
 * ## `lanes` has no counter to audit
 *
 * The counter audits here were `channels.follower_count` / `member_count` /
 * `post_count`, `$inc`-driven in Mongo where a decrement race could take one
 * negative. They left with the table. `lanes` deliberately carries no counter
 * (nothing ranks lanes), so there is nothing to audit and no absence to explain.
 */

import { laneMutes, lanes } from '../../schema/channels';
import type { CollectionPlan } from '../plan';
import { buildRow } from '../rowBuilder';
import { ownId, reqStr, str } from '../values';
import { timestamps } from './timestamps';

/** `lanes` → `lanes`. */
const lanesPlan: CollectionPlan = {
  collection: 'lanes',
  table: lanes,
  enumAudits: [{ path: 'displayMode', column: lanes.displayMode, absentAs: 'mixed' }],
  uniquenessAudits: [
    // Uniqueness is per PUBLISHER, and the publisher is now the WHOLE key.
    // `ownerType` used to lead it, because a user and a channel could hold the
    // same lane name; `0017` dropped the column, since a channel is an Oxy
    // account and the discriminator had one reachable value left. Under the old
    // key one publisher could hold a name twice, once per owner type.
    {
      index: 'lanes_owner_name_lower_key',
      key: [
        { path: 'ownerId', normalize: 'exact' },
        { path: 'nameLower', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    const rowId = ownId(doc);
    emit(
      lanes,
      buildRow(
        lanes,
        {
          id: rowId,
          // An Oxy account id — a person's or a channel's, which are the same
          // kind of thing now. No foreign key, for the reason recorded in
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

export const CHANNEL_PLANS: readonly CollectionPlan[] = [lanesPlan, laneMutesPlan];
