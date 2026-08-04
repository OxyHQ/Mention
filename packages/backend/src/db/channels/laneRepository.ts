/**
 * Writes to `lanes` — and the ONE definition of what a lane name IS.
 *
 * `lanes.name_lower` is what `lanes_owner_name_lower_key` is built on, and Mongo
 * derived it in a `pre('validate')` hook so no route, script or test could
 * arrive at a second spelling. A hook has no Postgres counterpart, so the
 * derivation lives here — see `schema/channels.ts`, which names this module as
 * where it went. The unique constraint stays the backstop: a missed derivation
 * is then a REFUSED write rather than a duplicate lane.
 *
 * Only the two writes that derive a column are here. Deleting a lane is a plain
 * `delete from lanes` at its one call site, because the cascade the Mongo route
 * had to sequence by hand is now the database's:
 * `posts.lane_id` is `ON DELETE SET NULL` and `lane_mutes.lane_id` is
 * `ON DELETE CASCADE`, so the three writes are one atomic statement with no
 * order to get wrong. Wrapping that in a function here would add a name, not a
 * rule.
 */

import { eq } from 'drizzle-orm';
import type { LaneDisplayMode } from '@mention/shared-types';
import { getDb } from '../postgres';
import { lanes } from '../schema/channels';

/** A lane row exactly as the routes read it back. */
export type LaneRow = typeof lanes.$inferSelect;

/**
 * The normalized identity of a lane name: trimmed, inner whitespace collapsed,
 * lowercased.
 *
 * Exported because a caller has to be able to ask "is this name empty once
 * normalized?" before offering it — `POST /lanes` and `PATCH /lanes/:id` both
 * answer 400 for a name that normalizes away, which is a better error than the
 * `not-null` violation the write would otherwise raise.
 */
export function normalizeLaneName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A new lane for one publisher. `name_lower` is derived here, never supplied. */
export async function insertLane(input: {
  ownerId: string;
  name: string;
  displayMode: LaneDisplayMode;
}): Promise<LaneRow> {
  const [row] = await getDb()
    .insert(lanes)
    .values({
      ownerId: input.ownerId,
      name: input.name,
      nameLower: normalizeLaneName(input.name),
      displayMode: input.displayMode,
    })
    .returning();
  return row;
}

/**
 * Rename a lane and/or move it between display modes.
 *
 * A `name` in the patch moves `name_lower` with it — the pair can never be
 * written apart, which is the whole reason this is not an inline `db.update` at
 * the route.
 *
 * @returns The updated row, or `null` when no lane has that id.
 */
export async function updateLane(
  laneId: string,
  patch: { name?: string; displayMode?: LaneDisplayMode },
): Promise<LaneRow | null> {
  const [row] = await getDb()
    .update(lanes)
    .set({
      ...(patch.name === undefined
        ? {}
        : { name: patch.name, nameLower: normalizeLaneName(patch.name) }),
      ...(patch.displayMode === undefined ? {} : { displayMode: patch.displayMode }),
    })
    .where(eq(lanes.id, laneId))
    .returning();
  return row ?? null;
}
