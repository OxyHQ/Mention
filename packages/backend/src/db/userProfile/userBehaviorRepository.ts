/**
 * The ONE read/write path for `user_behaviors` and its three preference child
 * tables.
 *
 * ## What the shape has to protect
 *
 * `UserBehavior` was the last Mongo-AUTHORITATIVE model with zero Postgres
 * writers, and it feeds For You ranking on every request. Both halves of a
 * partial port fail SILENTLY and in the same direction: a read that finds no row
 * is indistinguishable from a viewer who has never engaged with anything, so
 * affinity, preferred topics and preferred region all come back neutral, ForYou
 * degrades to generic ranking, and nothing anywhere produces an error. That is
 * why the writes and the reads move together and through one module.
 *
 * ## A child table is not an array
 *
 * `preferredAuthors` / `preferredTopics` / `preferredRegions` were arrays of
 * subdocuments and are child TABLES here. Mongo's `.save()` rewrote each array
 * wholesale, which was correct there and is destructive here: delete-then-insert
 * assigns every surviving preference a NEW row id on every interaction. So the
 * write is a DIFF — upsert on the natural key (which preserves the row), then
 * delete only the keys the mutation actually dropped.
 *
 * ## The concurrency guarantee moved from retry to a lock
 *
 * The accumulators are stateful and order-dependent (`+=`, a top-N sort+slice, a
 * multiplicative decay), so the write is a read-modify-write. Mongoose gave it
 * optimistic concurrency: two concurrent interactions for one viewer collided on
 * `__v`, and `UserPreferenceService` caught the `VersionError`, re-read and
 * re-applied, up to five times. Feed-impression telemetry fires many concurrent
 * interactions per viewer, so this was a live path, not a theoretical one.
 *
 * {@link updateUserBehavior} replaces that with `SELECT … FOR UPDATE` inside one
 * transaction: the second writer BLOCKS on the row until the first commits, then
 * reads the committed state and applies its mutation on top of it. Same end
 * state, no wasted work, and a lost update is not merely unlikely but
 * unreachable — so the retry loop, the `VersionError` classifier and the
 * duplicate-key classifier are gone rather than translated.
 */

import { and, eq, notInArray, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import {
  userBehaviorAuthors,
  userBehaviorRegions,
  userBehaviorTopics,
  userBehaviors,
} from '../schema/userProfile';
import type {
  AuthorPreference,
  RegionPreference,
  TopicPreference,
  UserBehaviorRecord,
} from './userBehaviorRecord';

type BehaviorRow = typeof userBehaviors.$inferSelect;

/** Assemble the parent row plus its three child sets into one record. */
function assembleRecord(
  row: BehaviorRow,
  preferredAuthors: AuthorPreference[],
  preferredTopics: TopicPreference[],
  preferredRegions: RegionPreference[],
): UserBehaviorRecord {
  return {
    oxyUserId: row.oxyUserId,
    preferredAuthors,
    preferredTopics,
    preferredRegions,
    preferredPostTypes: {
      text: row.preferredPostTypeText,
      image: row.preferredPostTypeImage,
      video: row.preferredPostTypeVideo,
      poll: row.preferredPostTypePoll,
    },
    activeHours: row.activeHours ?? [],
    averageEngagementTime: row.averageEngagementTime,
    skipRate: row.skipRate,
    completionRate: row.completionRate,
    hiddenAuthors: row.hiddenAuthors ?? [],
    mutedAuthors: row.mutedAuthors ?? [],
    blockedAuthors: row.blockedAuthors ?? [],
    hiddenTopics: row.hiddenTopics ?? [],
    lastUpdated: row.lastUpdated,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The three child sets for one behaviour row.
 *
 * Ordered strongest-first so the record reads the way Mongo's arrays did — the
 * service sorts before every top-N slice anyway, but a caller that reads the
 * record without sorting (`ContentAffinityService.collectPreferredTopics` caps
 * to the strongest N) must not have that cap depend on insertion order. The
 * second key makes ties deterministic rather than dependent on the plan.
 */
async function loadPreferences(
  behaviorId: string,
  db: DatabaseOrTransaction,
): Promise<{
  preferredAuthors: AuthorPreference[];
  preferredTopics: TopicPreference[];
  preferredRegions: RegionPreference[];
}> {
  const [authorRows, topicRows, regionRows] = await Promise.all([
    db
      .select()
      .from(userBehaviorAuthors)
      .where(eq(userBehaviorAuthors.behaviorId, behaviorId))
      .orderBy(sql`${userBehaviorAuthors.weight} desc, ${userBehaviorAuthors.authorId} asc`),
    db
      .select()
      .from(userBehaviorTopics)
      .where(eq(userBehaviorTopics.behaviorId, behaviorId))
      .orderBy(sql`${userBehaviorTopics.weight} desc, ${userBehaviorTopics.topic} asc`),
    db
      .select()
      .from(userBehaviorRegions)
      .where(eq(userBehaviorRegions.behaviorId, behaviorId))
      .orderBy(sql`${userBehaviorRegions.count} desc, ${userBehaviorRegions.region} asc`),
  ]);

  return {
    preferredAuthors: authorRows.map((author) => ({
      authorId: author.authorId,
      interactionCount: author.interactionCount,
      lastInteractionAt: author.lastInteractionAt,
      interactionTypes: {
        likes: author.likes,
        boosts: author.boosts,
        comments: author.comments,
        saves: author.saves,
        shares: author.shares,
      },
      weight: author.weight,
    })),
    preferredTopics: topicRows.map((topic) => ({
      topic: topic.topic,
      ...(topic.topicId === null ? {} : { topicId: topic.topicId }),
      interactionCount: topic.interactionCount,
      lastInteractionAt: topic.lastInteractionAt,
      weight: topic.weight,
    })),
    preferredRegions: regionRows.map((region) => ({
      region: region.region,
      count: region.count,
      lastInteractionAt: region.lastInteractionAt,
    })),
  };
}

/** One viewer's learned behaviour, or `null` when they have never had a row. */
export async function loadUserBehavior(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<UserBehaviorRecord | null> {
  const [row] = await db
    .select()
    .from(userBehaviors)
    .where(eq(userBehaviors.oxyUserId, oxyUserId));
  if (!row) return null;
  const preferences = await loadPreferences(row.id, db);
  return assembleRecord(
    row,
    preferences.preferredAuthors,
    preferences.preferredTopics,
    preferences.preferredRegions,
  );
}

/**
 * Write the parent row's own columns back.
 *
 * `preferredAuthors` / `preferredTopics` / `preferredRegions` are deliberately
 * absent — they live in the child tables below.
 */
async function writeBehaviorRow(
  behaviorId: string,
  behavior: UserBehaviorRecord,
  db: DatabaseOrTransaction,
): Promise<void> {
  await db
    .update(userBehaviors)
    .set({
      preferredPostTypeText: behavior.preferredPostTypes.text,
      preferredPostTypeImage: behavior.preferredPostTypes.image,
      preferredPostTypeVideo: behavior.preferredPostTypes.video,
      preferredPostTypePoll: behavior.preferredPostTypes.poll,
      activeHours: behavior.activeHours,
      averageEngagementTime: behavior.averageEngagementTime,
      skipRate: behavior.skipRate,
      completionRate: behavior.completionRate,
      hiddenAuthors: behavior.hiddenAuthors,
      mutedAuthors: behavior.mutedAuthors,
      blockedAuthors: behavior.blockedAuthors,
      hiddenTopics: behavior.hiddenTopics,
      lastUpdated: behavior.lastUpdated,
    })
    .where(eq(userBehaviors.id, behaviorId));
}

/** Upsert every author preference, then drop the ones the mutation removed. */
async function writeAuthorPreferences(
  behaviorId: string,
  preferences: readonly AuthorPreference[],
  db: DatabaseOrTransaction,
): Promise<void> {
  if (preferences.length > 0) {
    await db
      .insert(userBehaviorAuthors)
      .values(
        preferences.map((preference) => ({
          behaviorId,
          authorId: preference.authorId,
          interactionCount: preference.interactionCount,
          lastInteractionAt: preference.lastInteractionAt,
          likes: preference.interactionTypes.likes,
          boosts: preference.interactionTypes.boosts,
          comments: preference.interactionTypes.comments,
          saves: preference.interactionTypes.saves,
          shares: preference.interactionTypes.shares,
          weight: preference.weight,
        })),
      )
      .onConflictDoUpdate({
        target: [userBehaviorAuthors.behaviorId, userBehaviorAuthors.authorId],
        set: {
          interactionCount: sql`excluded.interaction_count`,
          lastInteractionAt: sql`excluded.last_interaction_at`,
          likes: sql`excluded.likes`,
          boosts: sql`excluded.boosts`,
          comments: sql`excluded.comments`,
          saves: sql`excluded.saves`,
          shares: sql`excluded.shares`,
          weight: sql`excluded.weight`,
        },
      });
  }

  // `notInArray` with an empty list is not "delete everything" — drizzle emits a
  // degenerate predicate for it — so the two cases are spelled separately.
  await db.delete(userBehaviorAuthors).where(
    preferences.length === 0
      ? eq(userBehaviorAuthors.behaviorId, behaviorId)
      : and(
          eq(userBehaviorAuthors.behaviorId, behaviorId),
          notInArray(
            userBehaviorAuthors.authorId,
            preferences.map((preference) => preference.authorId),
          ),
        ),
  );
}

/** Upsert every topic preference, then drop the ones the mutation removed. */
async function writeTopicPreferences(
  behaviorId: string,
  preferences: readonly TopicPreference[],
  db: DatabaseOrTransaction,
): Promise<void> {
  if (preferences.length > 0) {
    await db
      .insert(userBehaviorTopics)
      .values(
        preferences.map((preference) => ({
          behaviorId,
          topic: preference.topic,
          topicId: preference.topicId ?? null,
          interactionCount: preference.interactionCount,
          lastInteractionAt: preference.lastInteractionAt,
          weight: preference.weight,
        })),
      )
      .onConflictDoUpdate({
        target: [userBehaviorTopics.behaviorId, userBehaviorTopics.topic],
        set: {
          topicId: sql`excluded.topic_id`,
          interactionCount: sql`excluded.interaction_count`,
          lastInteractionAt: sql`excluded.last_interaction_at`,
          weight: sql`excluded.weight`,
        },
      });
  }

  await db.delete(userBehaviorTopics).where(
    preferences.length === 0
      ? eq(userBehaviorTopics.behaviorId, behaviorId)
      : and(
          eq(userBehaviorTopics.behaviorId, behaviorId),
          notInArray(
            userBehaviorTopics.topic,
            preferences.map((preference) => preference.topic),
          ),
        ),
  );
}

/** Upsert every region preference, then drop the ones the mutation removed. */
async function writeRegionPreferences(
  behaviorId: string,
  preferences: readonly RegionPreference[],
  db: DatabaseOrTransaction,
): Promise<void> {
  if (preferences.length > 0) {
    await db
      .insert(userBehaviorRegions)
      .values(
        preferences.map((preference) => ({
          behaviorId,
          region: preference.region,
          count: preference.count,
          lastInteractionAt: preference.lastInteractionAt,
        })),
      )
      .onConflictDoUpdate({
        target: [userBehaviorRegions.behaviorId, userBehaviorRegions.region],
        set: {
          count: sql`excluded.count`,
          lastInteractionAt: sql`excluded.last_interaction_at`,
        },
      });
  }

  await db.delete(userBehaviorRegions).where(
    preferences.length === 0
      ? eq(userBehaviorRegions.behaviorId, behaviorId)
      : and(
          eq(userBehaviorRegions.behaviorId, behaviorId),
          notInArray(
            userBehaviorRegions.region,
            preferences.map((preference) => preference.region),
          ),
        ),
  );
}

/** How {@link updateUserBehavior} treats a viewer who has no row yet. */
export interface UpdateUserBehaviorOptions {
  /**
   * Create the row when the viewer has none.
   *
   * `true` for the interaction path — a first interaction is exactly how a
   * viewer's behaviour starts existing. `false` (the default) for the two
   * callers that only ever REFINE a profile that is already there; creating one
   * for them would write an empty behaviour row for a viewer who has never
   * engaged with anything, which is precisely the state their own guard exists
   * to distinguish.
   */
  createIfMissing?: boolean;
}

/**
 * Read one viewer's behaviour, hand it to `apply`, and persist what `apply`
 * changed — all under a row lock held for the whole transaction.
 *
 * `apply` mutates the record in place, exactly as the Mongoose document was
 * mutated. It must stay synchronous and free of I/O: it runs while the row lock
 * is held, and awaiting anything there would hold that lock across a round trip
 * every other interaction for the same viewer would queue behind.
 *
 * @returns `true` when a row was mutated, `false` when the viewer had none and
 *   `createIfMissing` was not set — which lets a caller distinguish "refined an
 *   existing profile" from "there was nothing to refine", a distinction the
 *   Mongo code made with an early `return` on a null document.
 */
export async function updateUserBehavior(
  oxyUserId: string,
  apply: (behavior: UserBehaviorRecord) => void,
  options: UpdateUserBehaviorOptions = {},
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    if (options.createIfMissing) {
      // Two concurrent FIRST interactions both reach here; the loser blocks on
      // the unique index until the winner commits and then does nothing, which
      // is why this is an upsert rather than a select-then-insert.
      await tx
        .insert(userBehaviors)
        .values({ oxyUserId })
        .onConflictDoNothing({ target: userBehaviors.oxyUserId });
    }

    // The lock. Everything after this point — including the caller's read of the
    // record — sees a row no other transaction can be part-way through changing.
    const [row] = await tx
      .select()
      .from(userBehaviors)
      .where(eq(userBehaviors.oxyUserId, oxyUserId))
      .for('update');
    if (!row) return false;

    const preferences = await loadPreferences(row.id, tx);
    const behavior = assembleRecord(
      row,
      preferences.preferredAuthors,
      preferences.preferredTopics,
      preferences.preferredRegions,
    );

    apply(behavior);

    await writeBehaviorRow(row.id, behavior, tx);
    await writeAuthorPreferences(row.id, behavior.preferredAuthors, tx);
    await writeTopicPreferences(row.id, behavior.preferredTopics, tx);
    await writeRegionPreferences(row.id, behavior.preferredRegions, tx);
    return true;
  });
}

/**
 * Delete one viewer's learned behaviour.
 *
 * The three child tables are `ON DELETE CASCADE`, so this is the whole reset.
 *
 * @returns Whether a row existed to delete — the user-facing message
 *   distinguishes "reset" from "there was nothing to reset".
 */
export async function deleteUserBehavior(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const deleted = await db
    .delete(userBehaviors)
    .where(eq(userBehaviors.oxyUserId, oxyUserId))
    .returning({ id: userBehaviors.id });
  return deleted.length > 0;
}
