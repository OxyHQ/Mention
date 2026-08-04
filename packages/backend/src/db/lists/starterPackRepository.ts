/**
 * Writes to `starter_packs` that come from OUTSIDE the owner's own API.
 *
 * Today that is one caller: the atproto mirror, which imports a Bluesky starter
 * pack and re-imports it on every sync. It lives here rather than inside the
 * connector for the reason the poll repository exists — the pack and its ordered
 * members are two tables, and every writer has to keep them consistent in one
 * transaction. `routes/starterPacks.ts` owns the same invariant for packs a user
 * creates; this is the second writer, not a second SPELLING of the first.
 *
 * ## Why the mirror needed porting at all
 *
 * It upserted the Mongo `StarterPack` model while every reader had moved:
 * `routes/starterPacks.ts` serves the API from `starter_packs`, and
 * `starterPackCuration` ranks from `starter_pack_members`. So a mirrored pack
 * was written to a store nothing reads — it never appeared in the API, never
 * curated anything, and re-synced cleanly forever. The API even distinguishes
 * them (`isFederatedPack` reads `source_network`), which is what says they were
 * meant to be there.
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import { getDb } from '../postgres';
import { starterPackMembers, starterPacks } from '../schema/lists';

export interface MirroredStarterPack {
  /** The external network the pack is owned by. */
  sourceNetwork: 'atproto';
  /** The source pack's canonical AT-URI — the dedup key for a re-sync. */
  sourceUri: string;
  ownerOxyUserId: string;
  name: string;
  /** Members in the upstream order; that order IS the render order. */
  memberOxyUserIds: readonly string[];
}

/**
 * Create or refresh one mirrored pack and its membership, in one transaction.
 *
 * Keyed on `sourceUri` through `starter_packs_source_uri_key`, the PARTIAL
 * unique index (`where source_uri is not null`) — so the conflict target carries
 * the same predicate. Without it Postgres cannot match the arbiter index and
 * raises `there is no unique or exclusion constraint matching the ON CONFLICT
 * specification`, which is a run-time error no type would have caught.
 *
 * The three `source_*` columns are written together because
 * `starter_packs_source_complete_check` requires all-or-nothing: Mongo held them
 * as one subdocument, where that was free.
 *
 * @returns The pack's id.
 */
export async function upsertMirroredStarterPack(pack: MirroredStarterPack): Promise<string> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .insert(starterPacks)
      .values({
        ownerOxyUserId: pack.ownerOxyUserId,
        name: pack.name,
        sourceNetwork: pack.sourceNetwork,
        sourceUri: pack.sourceUri,
        sourceSyncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: starterPacks.sourceUri,
        targetWhere: isNotNull(starterPacks.sourceUri),
        set: {
          ownerOxyUserId: pack.ownerOxyUserId,
          name: pack.name,
          sourceSyncedAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning({ id: starterPacks.id });

    // DELETE-then-INSERT, same reasoning as the owner-facing path: `(pack_id,
    // position)` is UNIQUE and Postgres checks it per STATEMENT, so reordering
    // in place collides with whichever row still holds the target position. The
    // delete runs first so the insert sees no old rows and `position` runs
    // 0…n-1 with nothing to collide with.
    await tx.delete(starterPackMembers).where(eq(starterPackMembers.packId, row.id));
    if (pack.memberOxyUserIds.length > 0) {
      // Deduped, because `(pack_id, oxy_user_id)` is UNIQUE and an upstream pack
      // can list one account twice — Bluesky's list items are not constrained
      // that way. FIRST occurrence wins, which preserves the upstream order and
      // invents nothing; a duplicate is a duplicate, not a correction.
      const seen = new Set<string>();
      const values: Array<{ packId: string; oxyUserId: string; position: number }> = [];
      for (const oxyUserId of pack.memberOxyUserIds) {
        if (seen.has(oxyUserId)) continue;
        seen.add(oxyUserId);
        values.push({ packId: row.id, oxyUserId, position: values.length });
      }
      await tx.insert(starterPackMembers).values(values);
    }

    return row.id;
  });
}

/** One mirrored pack by its source URI, or `null`. Exists for the sync's own reads. */
export async function findMirroredStarterPack(
  sourceNetwork: 'atproto',
  sourceUri: string
): Promise<{ id: string; name: string } | null> {
  const [row] = await getDb()
    .select({ id: starterPacks.id, name: starterPacks.name })
    .from(starterPacks)
    .where(and(eq(starterPacks.sourceNetwork, sourceNetwork), eq(starterPacks.sourceUri, sourceUri)))
    .limit(1);
  return row ?? null;
}
