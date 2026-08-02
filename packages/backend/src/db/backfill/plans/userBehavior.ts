/**
 * `userbehaviors` → `user_behaviors` + three child tables.
 *
 * One document becomes one parent row plus a row per entry of
 * `preferredAuthors`, `preferredTopics` and `preferredRegions`. The four fixed
 * `preferredPostTypes` buckets stay COLUMNS rather than becoming a fourth child
 * table, because the set is closed and named in the schema.
 *
 * ## What goes wrong if this is wrong and no audit catches it
 *
 * This is the feed's model of what a person likes, and it fails QUIETLY in a way
 * users read as the product having an opinion about them. Nothing errors, no
 * page breaks: a dropped `preferredAuthors` row means the accounts someone
 * engages with most stop being favoured, and a corrupted `weight` is worse than
 * a missing one — a weight of 1 on an author they interacted with once pins that
 * author to the top of every session. Because the whole structure is a learned
 * cache, a reader cannot tell a bad migration from the model legitimately
 * changing its mind, and it decays back to correct over weeks of engagement.
 * That slow silent recovery is exactly why the copy has to be right: nobody will
 * report it, and by the time anyone looks the evidence has faded.
 *
 * `weight` is therefore audited (`between 0 and 1`) rather than clamped. A
 * clamp would turn a corrupt 7.5 into a legal 1 — the single most damaging
 * value it could take — under the appearance of having fixed something.
 *
 * ## Ordering: none is carried, and none is owed
 *
 * The three child tables have no `position` column and nothing reads them in
 * array order — the affinity lists are ranked by `weight` / `interaction_count`
 * / `count`, all of which are real stored values with no dependence on `now()`
 * or on an id tiebreak. So there is no ordinal to preserve here and no
 * `created_at` fallback to be caught by, which is the trap `poll_votes` needed a
 * derived timestamp for.
 *
 * ## Within-array duplicates are normalized, and are not auditable
 *
 * Each child carries a natural unique key — `(behavior_id, author_id)`,
 * `(behavior_id, topic)`, `(behavior_id, region)` — that Mongo did not have, and
 * `UniquenessAudit` groups over DOCUMENTS so it cannot see one document naming
 * an author twice. Same hole as `plans/content.ts`, same resolution: keep the
 * entry with the newest `lastInteractionAt`, because these are recency-weighted
 * affinity records and the newest is what the live service would hold.
 *
 * Count affected documents before a run with (authors; the other two are the
 * same shape against `preferredTopics.topic` / `preferredRegions.region`):
 *   db.userbehaviors.aggregate([
 *     {$project: {n: {$size: '$preferredAuthors'},
 *                 u: {$size: {$setUnion: '$preferredAuthors.authorId'}}}},
 *     {$match: {$expr: {$ne: ['$n', '$u']}}}, {$count: 'documents'}])
 */

import {
  userBehaviorAuthors,
  userBehaviorRegions,
  userBehaviorTopics,
  userBehaviors,
} from '../../schema/userProfile';
import type { CollectionPlan } from '../plan';
import { buildRow } from '../rowBuilder';
import {
  childRowId,
  date,
  id as objectId,
  int,
  num,
  numArray,
  ownId,
  reqStr,
  strArray,
  subdocuments,
  type MongoDocument,
} from '../values';
import { optionalDate, timestamps } from './timestamps';

/**
 * Keep one entry per natural key, preferring the newest `lastInteractionAt`.
 *
 * Chosen by the stored TIMESTAMP rather than by array position: a later position
 * is usually the more recent record, but "usually" is not a rule the copy can
 * rely on, and the timestamp is the value the ranking actually reads.
 */
function newestPerKey(
  entries: Array<[MongoDocument, number]>,
  keyOf: (entry: MongoDocument) => string
): Array<{ entry: MongoDocument; position: number; key: string }> {
  const kept = new Map<string, { entry: MongoDocument; position: number; key: string; at: number }>();
  for (const [entry, position] of entries) {
    const key = keyOf(entry);
    // An absent `lastInteractionAt` sorts OLDEST rather than newest: Mongoose
    // defaults it to `Date.now` on write, so a missing one means the entry
    // predates that default and is the older record by construction.
    const at = date(entry, 'lastInteractionAt')?.getTime() ?? Number.NEGATIVE_INFINITY;
    const existing = kept.get(key);
    if (existing === undefined || at > existing.at) kept.set(key, { entry, position, key, at });
  }
  return [...kept.values()];
}

const userBehaviorsPlan: CollectionPlan = {
  collection: 'userbehaviors',
  table: userBehaviors,
  childTables: [userBehaviorAuthors, userBehaviorTopics, userBehaviorRegions],
  numericAudits: [
    // `distinct` on an ARRAY path returns the elements, which is what makes the
    // three child-field audits below possible at all — same property the enum
    // audit on `allow.type` relies on in `plans/gates.ts`.
    {
      path: 'skipRate',
      column: userBehaviors.skipRate,
      constraint: 'user_behaviors_rates_check',
      min: 0,
      max: 1,
      absentAs: 0,
    },
    {
      path: 'completionRate',
      column: userBehaviors.completionRate,
      constraint: 'user_behaviors_rates_check',
      min: 0,
      max: 1,
      absentAs: 0,
    },
    {
      path: 'activeHours',
      column: userBehaviors.activeHours,
      constraint: 'user_behaviors_active_hours_check',
      min: 0,
      max: 23,
    },
    {
      path: 'preferredAuthors.weight',
      column: userBehaviorAuthors.weight,
      constraint: 'user_behavior_authors_weight_check',
      min: 0,
      max: 1,
      absentAs: 0,
    },
    {
      path: 'preferredTopics.weight',
      column: userBehaviorTopics.weight,
      constraint: 'user_behavior_topics_weight_check',
      min: 0,
      max: 1,
      absentAs: 0,
    },
    {
      path: 'preferredRegions.count',
      column: userBehaviorRegions.count,
      constraint: 'user_behavior_regions_count_check',
      min: 0,
      absentAs: 0,
    },
  ],
  uniquenessAudits: [
    // Mongo declares `oxyUserId` unique, so a finding means the index is absent
    // or non-unique in production — worth knowing before the run rather than as
    // a `23505` partway through it.
    { index: 'user_behaviors_oxy_user_id_key', key: [{ path: 'oxyUserId', normalize: 'exact' }] },
  ],
  transform: (doc, emit) => {
    const behaviorId = ownId(doc);

    emit(
      userBehaviors,
      buildRow(
        userBehaviors,
        {
          id: behaviorId,
          oxyUserId: reqStr(doc, 'oxyUserId'),
          // `?? 0` rather than omitting the key. The column default and the
          // Mongoose default are both 0, so the two spellings agree — but stating
          // it means the row does not depend on the database filling a blank,
          // which is the class of silence that dated six posts to the migration
          // instant elsewhere in this port.
          preferredPostTypeText: int(doc, 'preferredPostTypes.text') ?? 0,
          preferredPostTypeImage: int(doc, 'preferredPostTypes.image') ?? 0,
          preferredPostTypeVideo: int(doc, 'preferredPostTypes.video') ?? 0,
          preferredPostTypePoll: int(doc, 'preferredPostTypes.poll') ?? 0,
          // NULLABLE arrays, so an absent one stays NULL rather than becoming
          // `{}`: "never learned an active hour" and "learned that none applies"
          // are different, and only the source can say which.
          activeHours: numArray(doc, 'activeHours'),
          preferredLanguages: strArray(doc, 'preferredLanguages'),
          averageEngagementTime: num(doc, 'averageEngagementTime') ?? 0,
          skipRate: num(doc, 'skipRate') ?? 0,
          completionRate: num(doc, 'completionRate') ?? 0,
          hiddenAuthors: strArray(doc, 'hiddenAuthors'),
          mutedAuthors: strArray(doc, 'mutedAuthors'),
          blockedAuthors: strArray(doc, 'blockedAuthors'),
          hiddenTopics: strArray(doc, 'hiddenTopics'),
          // NOT NULL with `defaultNow()`, and the model defaults it on write —
          // so an absent value means a document older than the field, and the
          // default is the honest answer rather than an invented date.
          ...optionalDate(doc, 'lastUpdated', 'lastUpdated'),
          ...timestamps(doc),
        },
        behaviorId
      )
    );

    for (const { entry, position } of newestPerKey(
      subdocuments(doc, 'preferredAuthors'),
      (entry) => reqStr(entry, 'authorId')
    )) {
      emit(
        userBehaviorAuthors,
        buildRow(
          userBehaviorAuthors,
          {
            id: childRowId(entry, behaviorId, 'preferredAuthors', position),
            behaviorId,
            authorId: reqStr(entry, 'authorId'),
            interactionCount: int(entry, 'interactionCount') ?? 0,
            ...optionalDate(entry, 'lastInteractionAt', 'lastInteractionAt'),
            // The five counters flatten out of the `interactionTypes`
            // subdocument into columns; the set is closed and named, so it does
            // not earn a table of its own.
            likes: int(entry, 'interactionTypes.likes') ?? 0,
            boosts: int(entry, 'interactionTypes.boosts') ?? 0,
            comments: int(entry, 'interactionTypes.comments') ?? 0,
            saves: int(entry, 'interactionTypes.saves') ?? 0,
            shares: int(entry, 'interactionTypes.shares') ?? 0,
            // NOT clamped. An out-of-range weight is a finding for the audit
            // above to report by id — clamping 7.5 to 1 would convert corruption
            // into the most damaging legal value there is, silently.
            weight: num(entry, 'weight') ?? 0,
          },
          behaviorId
        )
      );
    }

    for (const { entry, position } of newestPerKey(
      subdocuments(doc, 'preferredTopics'),
      (entry) => reqStr(entry, 'topic')
    )) {
      emit(
        userBehaviorTopics,
        buildRow(
          userBehaviorTopics,
          {
            id: childRowId(entry, behaviorId, 'preferredTopics', position),
            behaviorId,
            topic: reqStr(entry, 'topic'),
            // An Oxy Topic-registry id with no local table and no foreign key
            // (`schema/deferredForeignKeys.ts` records why). Mongo typed it as an
            // ObjectId, so it arrives as one and is stored as its hex string.
            topicId: objectId(entry, 'topicId'),
            interactionCount: int(entry, 'interactionCount') ?? 0,
            ...optionalDate(entry, 'lastInteractionAt', 'lastInteractionAt'),
            weight: num(entry, 'weight') ?? 0,
          },
          behaviorId
        )
      );
    }

    for (const { entry, position } of newestPerKey(
      subdocuments(doc, 'preferredRegions'),
      (entry) => reqStr(entry, 'region')
    )) {
      emit(
        userBehaviorRegions,
        buildRow(
          userBehaviorRegions,
          {
            id: childRowId(entry, behaviorId, 'preferredRegions', position),
            behaviorId,
            region: reqStr(entry, 'region'),
            // `count` is an accumulated engagement WEIGHT, not a tally, so it is
            // `doublePrecision` on both sides and read with `num`, never `int`.
            count: num(entry, 'count') ?? 0,
            ...optionalDate(entry, 'lastInteractionAt', 'lastInteractionAt'),
          },
          behaviorId
        )
      );
    }
  },
};

/** Every user-behaviour plan. */
export const USER_BEHAVIOR_PLANS: readonly CollectionPlan[] = [userBehaviorsPlan];
