/**
 * Discovery and delivery: `trendings` `trendbatches` `trendsummaries`
 * `trendgraphs` `topicstats` `authorfollowersnapshots` `gifs` `notifications`
 * `pushtokens`.
 *
 * Nine collections, one row each, no child tables — the last two arrived on
 * merges from `main` and are documented at their own plans. What makes them
 * worth reading rather than skimming is that six of the nine carry a DENORMALIZED
 * COUNTER with a `>= 0` CHECK, which is the class the numeric audit was built
 * for: Mongoose's `min:` never ran here (`runValidators` is set nowhere in this
 * package), so a counter driven below zero by a decrement race is legal in the
 * source and rejected by the target.
 *
 * ## Three of these collections have a Mongo TTL index, and it is still running
 *
 * `trendings`, `notifications` and `authorfollowersnapshots` are reaped by
 * MongoDB's background TTL monitor. That matters to a COPY in a way it does not
 * matter to a query: the source is shrinking underneath the run, so a document
 * counted during discovery can be gone by the time the stream reaches it. That
 * is not a fault — the row was expiring anyway and Postgres has its own sweep
 * (`db/expiry.ts`) with the same windows — but it does mean the verifier's count
 * check can legitimately come out one or two short on these three after a long
 * run, and reading that as data loss would be wrong.
 *
 * ## `updatedAt` is copied, never defaulted — and `trendings` has no `createdAt`
 *
 * Both timestamp columns carry a database default, so omitting them would stamp
 * every migrated row with the migration's own clock and destroy the history the
 * migration exists to preserve. `trendings` and `trendbatches` declare no
 * `{ timestamps: true }` at all: `trending` has a hand-declared `updatedAt` and
 * no `createdAt` (its table matches), and `trend_batches` has neither.
 */

import {
  authorFollowerSnapshots,
  gifs,
  notifications,
  pushTokens,
  topicStats,
  trendSummaries,
  trendBatches,
  trendGraphs,
  trending,
  type StoredTrendGraphNode,
} from '../../schema/discovery';
import type { TrendGraphEdgeDTO } from '@mention/shared-types';
import type { CollectionPlan } from '../plan';
import { allowedValues } from '../plan';
import type { MongoDocument } from '../values';
import type { ResolutionContext } from '../resolutions';
import { MAP_LEGACY_PUSH_TOKEN_TYPE } from '../resolutions';
import { buildRow } from '../rowBuilder';
import { bool, date, id, int, jsonArray, num, ownId, reqDate, reqId, reqInt, reqNum, reqStr, str, strArray } from '../values';
import { optionalDate, timestamps, updatedOnly } from './timestamps';

/** `trendings` → `trending`. */
const trendingPlan: CollectionPlan = {
  collection: 'trendings',
  table: trending,
  enumAudits: [
    { path: 'type', column: trending.type },
    // Both NULLABLE, and both closed sets the CHECKs constrain. `category` is
    // the one vocabulary in this table that Mongo and Postgres import from the
    // SAME `@mention/shared-types` constant, so it cannot drift — but the DATA
    // can still hold a value from before a narrowing, which is the only thing
    // an audit ever measured.
    { path: 'category', column: trending.category },
    { path: 'status', column: trending.status },
  ],
  numericAudits: [
    {
      path: 'volume',
      column: trending.volume,
      constraint: 'trending_volume_check',
      min: 0,
      absentAs: 0,
    },
  ],
  uniquenessAudits: [
    {
      // The order is the schema's, and it is load-bearing there for index-prefix
      // reasons. It is irrelevant to the audit, which groups on the whole key —
      // but writing it in a different order here would read as a second opinion
      // about the index.
      index: 'trending_name_calculated_at_type_key',
      key: [
        { path: 'name', normalize: 'exact' },
        { path: 'calculatedAt', normalize: 'exact' },
        { path: 'type', normalize: 'exact' },
      ],
    },
  ],
  // EIGHT of these were dropped by a complete, exit-0, `AUDIT CLEAN` rehearsal.
  // Migration `0006_trend_labels_and_bridged_identity` added the columns and no
  // plan was ever extended to feed them, which produces exactly one row per
  // document — so every row-cardinality check passed while the labels, the
  // burst statistic, the onset time and the actor lists were all discarded.
  // Declaring where each column comes from is what turns that from invisible
  // into measured.
  columnCoverage: [
    { table: trending, column: trending.displayName, sourcePath: 'displayName' },
    { table: trending, column: trending.category, sourcePath: 'category' },
    { table: trending, column: trending.labelVersion, sourcePath: 'labelVersion' },
    { table: trending, column: trending.languages, sourcePath: 'languages' },
    { table: trending, column: trending.authorCount, sourcePath: 'authorCount' },
    { table: trending, column: trending.burstScore, sourcePath: 'burstScore' },
    { table: trending, column: trending.startedAt, sourcePath: 'startedAt' },
    { table: trending, column: trending.status, sourcePath: 'status' },
    { table: trending, column: trending.actorIds, sourcePath: 'actorIds' },
    { table: trending, column: trending.terms, sourcePath: 'terms' },
    { table: trending, column: trending.topicId, sourcePath: 'topicId' },
    {
      table: trending,
      column: trending.description,
      sourcePath: 'description',
      filledWhenAbsent:
        'the column is NOT NULL DEFAULT \'\' and a trend without a description ' +
        'is displayed as having none — the empty string IS the absence here, ' +
        'not a stand-in for a value that was lost.',
    },
  ],
  transform: (doc, emit) => {
    emit(
      trending,
      buildRow(
        trending,
        {
          id: ownId(doc),
          type: reqStr(doc, 'type'),
          name: reqStr(doc, 'name'),
          // The DISPLAY label ("Kremer Trade" for the term `orioles`). A row
          // without one falls back to `name`, so dropping it silently degraded
          // every labelled trend to its raw retrieval term.
          displayName: str(doc, 'displayName'),
          category: str(doc, 'category'),
          labelVersion: int(doc, 'labelVersion'),
          languages: strArray(doc, 'languages'),
          description: str(doc, 'description') ?? '',
          score: reqNum(doc, 'score'),
          volume: int(doc, 'volume') ?? 0,
          // DISTINCT authors, which is what the reporting floor is applied to —
          // a stored row without it cannot explain why it qualified.
          authorCount: int(doc, 'authorCount'),
          // The actual trend measurement, in standard deviations above the
          // term's own baseline. `score` only orders the list.
          burstScore: num(doc, 'burstScore'),
          momentum: num(doc, 'momentum') ?? 0,
          startedAt: date(doc, 'startedAt'),
          status: str(doc, 'status'),
          actorIds: strArray(doc, 'actorIds'),
          // Every term the row stands for, `name` first. Without it a merged
          // row opens onto a feed missing every post that used one of the other
          // names — the merge would be actively harmful rather than merely lossy.
          terms: strArray(doc, 'terms'),
          rank: reqInt(doc, 'rank'),
          // An Oxy Topic-registry id. Declared `Schema.Types.ObjectId` in the
          // model and `text` here with no foreign key, because the registry is
          // Oxy's — `id()` is what turns the one into the other verbatim.
          topicId: id(doc, 'topicId'),
          calculatedAt: reqDate(doc, 'calculatedAt'),
          ...updatedOnly(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** `trendbatches` → `trend_batches`. No timestamps on either side. */
const trendBatchesPlan: CollectionPlan = {
  collection: 'trendbatches',
  table: trendBatches,
  uniquenessAudits: [
    {
      index: 'trend_batches_calculated_at_key',
      key: [{ path: 'calculatedAt', normalize: 'exact' }],
    },
  ],
  transform: (doc, emit) => {
    emit(
      trendBatches,
      buildRow(
        trendBatches,
        {
          id: ownId(doc),
          calculatedAt: reqDate(doc, 'calculatedAt'),
          summary: str(doc, 'summary') ?? '',
        },
        ownId(doc)
      )
    );
  },
};

/** `topicstats` → `topic_stats`. */
const topicStatsPlan: CollectionPlan = {
  collection: 'topicstats',
  table: topicStats,
  numericAudits: [
    {
      path: 'postCount',
      column: topicStats.postCount,
      constraint: 'topic_stats_post_count_check',
      min: 0,
      absentAs: 0,
    },
  ],
  uniquenessAudits: [
    {
      index: 'topic_stats_topic_id_key',
      key: [{ path: 'topicId', normalize: 'exact' }],
    },
  ],
  transform: (doc, emit) => {
    emit(
      topicStats,
      buildRow(
        topicStats,
        {
          id: ownId(doc),
          // `String` in the model, not an ObjectId — unlike `trending.topicId`,
          // which names the same registry through a different declaration. Both
          // go through `id()`, which accepts either and preserves both verbatim.
          topicId: reqStr(doc, 'topicId'),
          popularity: num(doc, 'popularity') ?? 0,
          postCount: int(doc, 'postCount') ?? 0,
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** `authorfollowersnapshots` → `author_follower_snapshots`. */
const authorFollowerSnapshotsPlan: CollectionPlan = {
  collection: 'authorfollowersnapshots',
  table: authorFollowerSnapshots,
  numericAudits: [
    {
      path: 'followerCount',
      column: authorFollowerSnapshots.followerCount,
      constraint: 'author_follower_snapshots_follower_count_check',
      // NO `absentAs`: the column is NOT NULL with no default and the transform
      // supplies none, so an absent value is a `23502` and must be reported
      // rather than quietly assumed to be zero. A snapshot with no count is not
      // a snapshot of zero followers.
      min: 0,
    },
  ],
  transform: (doc, emit) => {
    emit(
      authorFollowerSnapshots,
      buildRow(
        authorFollowerSnapshots,
        {
          id: ownId(doc),
          oxyUserId: reqStr(doc, 'oxyUserId'),
          followerCount: reqInt(doc, 'followerCount'),
          // `at` carries a database default, so an absent one is OMITTED rather
          // than nulled — but the model defaults it on write too, so in practice
          // every document has one and the default never fires.
          ...optionalDate(doc, 'at', 'at'),
        },
        ownId(doc)
      )
    );
  },
};

/** `gifs` → `gifs`. */
const gifsPlan: CollectionPlan = {
  collection: 'gifs',
  table: gifs,
  enumAudits: [{ path: 'source', column: gifs.source, absentAs: 'klipy' }],
  numericAudits: [
    // The CHECK is `> 0`, and these are `integer` columns, so `>= 1` is the
    // same predicate over the same domain. Written as a bound rather than a
    // strict inequality because that is the shape `NumericAudit` has; the
    // equivalence is exact here and would NOT be for a `double precision`
    // column, where 0.5 satisfies `> 0` and fails `>= 1`.
    { path: 'width', column: gifs.width, constraint: 'gifs_dimensions_check', min: 1 },
    { path: 'height', column: gifs.height, constraint: 'gifs_dimensions_check', min: 1 },
    {
      path: 'useCount',
      column: gifs.useCount,
      constraint: 'gifs_counts_check',
      min: 0,
      absentAs: 0,
    },
    {
      path: 'searchHitCount',
      column: gifs.searchHitCount,
      constraint: 'gifs_counts_check',
      min: 0,
      absentAs: 0,
    },
  ],
  uniquenessAudits: [
    { index: 'gifs_klipy_id_key', key: [{ path: 'klipyId', normalize: 'exact' }] },
  ],
  transform: (doc, emit) => {
    emit(
      gifs,
      buildRow(
        gifs,
        {
          id: ownId(doc),
          klipyId: reqStr(doc, 'klipyId'),
          source: str(doc, 'source') ?? 'klipy',
          slug: str(doc, 'slug') ?? '',
          title: str(doc, 'title') ?? '',
          searchTerms: strArray(doc, 'searchTerms') ?? [],
          width: reqInt(doc, 'width'),
          height: reqInt(doc, 'height'),
          mp4FileId: reqStr(doc, 'mp4FileId'),
          previewFileId: reqStr(doc, 'previewFileId'),
          useCount: int(doc, 'useCount') ?? 0,
          searchHitCount: int(doc, 'searchHitCount') ?? 0,
          ...optionalDate(doc, 'lastUsedAt', 'lastUsedAt'),
          ...timestamps(doc),
          // `searchVector` is GENERATED ALWAYS from `search_terms` and `title`.
          // Naming it here at all would throw in `buildRow` — which is the
          // point: Mongo's `$text` index has no stored counterpart to carry
          // across, and a transform that tried would fail in a unit test rather
          // than on a `428C9` at hour three.
        },
        ownId(doc)
      )
    );
  },
};

/** `notifications` → `notifications`. */
const notificationsPlan: CollectionPlan = {
  collection: 'notifications',
  table: notifications,
  enumAudits: [
    { path: 'type', column: notifications.type },
    { path: 'entityType', column: notifications.entityType },
  ],
  uniquenessAudits: [
    {
      index: 'notifications_dedup_key',
      key: [
        { path: 'recipientId', normalize: 'exact' },
        { path: 'actorId', normalize: 'exact' },
        { path: 'type', normalize: 'exact' },
        { path: 'entityId', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    emit(
      notifications,
      buildRow(
        notifications,
        {
          id: ownId(doc),
          recipientId: reqStr(doc, 'recipientId'),
          actorId: reqStr(doc, 'actorId'),
          type: reqStr(doc, 'type'),
          // POLYMORPHIC by `entityType`: a `posts.id` for `post`/`reply`, an Oxy
          // account id for `profile`. The model declares it `ObjectId` for all
          // three, which only works because an Oxy account id is 24 hex
          // characters and casts — so `id()` is what preserves either verbatim,
          // and the column carries no foreign key precisely because half its
          // values name a row in another service.
          entityId: reqId(doc, 'entityId'),
          entityType: reqStr(doc, 'entityType'),
          read: bool(doc, 'read') ?? false,
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/**
 * The transport a push token registers under, rewriting the legacy spelling.
 *
 * NARROW BY CONSTRUCTION, in the same sense as
 * {@link DROP_UNREAD_FEED_ENTITY_FOLLOWS}: the accepted set is read off the
 * column rather than restated, so a value the schema later admits passes
 * through untouched and only a value it refuses is ever rewritten. `'android'`
 * has the evidence behind it recorded on the rule; anything else lands on the
 * vocabulary's own `'unknown'`, because mapping an unexamined value onto a real
 * transport would be inventing a fact rather than migrating one.
 */
function pushTokenType(doc: MongoDocument, resolutions: ResolutionContext): string {
  const raw = str(doc, 'type');
  // Absent is not the same question — `absentAs` declares that one, and this
  // line is the transform doing exactly what it declares.
  if (raw === null) return 'unknown';
  if (allowedValues(pushTokens.type).includes(raw)) return raw;

  const mapped = raw === 'android' ? 'fcm' : 'unknown';
  resolutions.record({
    rule: MAP_LEGACY_PUSH_TOKEN_TYPE,
    documentId: ownId(doc),
    detail: `type ${JSON.stringify(raw)} rewritten to ${JSON.stringify(mapped)}`,
    // The original value is the only thing that stops existing once the row is
    // written, so it is what the report carries.
    evidence: { 'push_tokens.type (source)': raw, 'push_tokens.type (written)': mapped },
  });
  return mapped;
}

/** `pushtokens` → `push_tokens`. */
const pushTokensPlan: CollectionPlan = {
  collection: 'pushtokens',
  table: pushTokens,
  enumAudits: [
    // This is what REPORTS the legacy `'android'` spelling before anything is
    // copied; the rule below is what answers the finding. `absentAs` covers a
    // MISSING type, which is a different question from a present-but-unaccepted
    // one — the transform substitutes for the first and rewrites the second.
    {
      path: 'type',
      column: pushTokens.type,
      absentAs: 'unknown',
      resolvedBy: MAP_LEGACY_PUSH_TOKEN_TYPE,
    },
    { path: 'platform', column: pushTokens.platform, absentAs: 'unknown' },
  ],
  uniquenessAudits: [
    { index: 'push_tokens_token_key', key: [{ path: 'token', normalize: 'exact' }] },
  ],
  transform: (doc, emit, resolutions) => {
    emit(
      pushTokens,
      buildRow(
        pushTokens,
        {
          id: ownId(doc),
          userId: reqStr(doc, 'userId'),
          token: reqStr(doc, 'token'),
          type: pushTokenType(doc, resolutions),
          platform: str(doc, 'platform') ?? 'unknown',
          // Both nullable, and both stay NULL when absent rather than becoming
          // `''` — an empty locale is a VALUE and would be matched by a lookup
          // for it.
          deviceId: str(doc, 'deviceId'),
          locale: str(doc, 'locale'),
          enabled: bool(doc, 'enabled') ?? true,
          ...optionalDate(doc, 'lastSeenAt', 'lastSeenAt'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** Every discovery plan. */
/**
 * `trendsummaries` → `trend_summaries`.
 *
 * Arrived with the merge that brought `main`'s trending rewrite, which is why it
 * is here rather than with the seven above: the table did not exist when this
 * module was written, and the audit's completeness gate is what surfaced it —
 * it refused the whole run naming this table, rather than copying the other 43
 * collections and leaving one silently empty.
 *
 * Derived text with a Mongo TTL (`generatedAt`, `TREND_SUMMARY_TTL_SECONDS`), so
 * it belongs to the same shrinking-source class as `trendings` and
 * `notifications`: a document counted during discovery can be reaped before the
 * stream reaches it, and the verifier coming out one or two short after a long
 * run is the TTL doing its job rather than data loss.
 *
 * `generatedAt` is copied rather than defaulted for the reason the module
 * docblock gives, and here it is load-bearing twice over: it is also what
 * Postgres' own sweep (`db/expiry.ts`) reads to decide what to reap, so a
 * defaulted value would hand every migrated summary a fresh lease and keep text
 * alive that Mongo had already scheduled for deletion.
 *
 * The schema declares no `{ timestamps: true }` — the four fields below are the
 * whole document, and the table matches.
 */
const trendSummariesPlan: CollectionPlan = {
  collection: 'trendsummaries',
  table: trendSummaries,
  uniquenessAudits: [
    // The identity of a summary, and what makes generation idempotent: the model
    // declares this unique index for exactly that reason, so a duplicate here
    // would mean the source violated its own constraint.
    {
      index: 'trend_summaries_term_run_started_at_key',
      key: [
        { path: 'term', normalize: 'exact' },
        { path: 'runStartedAt', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    const id = ownId(doc);
    emit(
      trendSummaries,
      buildRow(
        trendSummaries,
        {
          id,
          term: reqStr(doc, 'term'),
          runStartedAt: reqDate(doc, 'runStartedAt'),
          description: reqStr(doc, 'description'),
          generatedAt: reqDate(doc, 'generatedAt'),
        },
        id
      )
    );
  },
};

/**
 * `trendgraphs` → `trend_graphs`.
 *
 * Arrived on the same merge as `main`'s Channels/Lanes work, one release after
 * `trendsummaries` arrived the same way — which is the pattern the completeness
 * gate exists for and the reason it is written rather than argued away.
 *
 * The argument for skipping it is real and still loses: a graph is DERIVED, it
 * has a 7-day TTL, and the next trending batch writes a fresh one within thirty
 * minutes of cutover, so at most a few hundred rows of picture are at stake. But
 * "nothing would notice" is exactly what a silently-empty table looks like, and
 * the plan is eight lines.
 *
 * `nodes` and `edges` are copied as WHOLE ARRAYS into their `jsonb` columns,
 * which is what the table stores and why it stores it that way — see the schema.
 * A Mongo subdocument array arrives as plain objects here, so there is no
 * per-element shape to rebuild.
 *
 * `calculatedAt` is copied rather than defaulted, and load-bearing twice for the
 * same reason `trendsummaries.generatedAt` is: it is also the column Postgres'
 * own sweep reads, so a defaulted value would hand every migrated graph a fresh
 * 7-day lease on data Mongo had already scheduled for deletion. It puts this
 * collection in the shrinking-source class too — a document counted during
 * discovery can be reaped before the stream reaches it.
 */
const trendGraphsPlan: CollectionPlan = {
  collection: 'trendgraphs',
  table: trendGraphs,
  uniquenessAudits: [
    // One graph per batch. The model declares this unique so a retried batch
    // cannot leave two, so a duplicate here would mean the source violated its
    // own constraint.
    {
      index: 'trend_graphs_calculated_at_key',
      key: [{ path: 'calculatedAt', normalize: 'exact' }],
    },
  ],
  transform: (doc, emit) => {
    const rowId = ownId(doc);
    emit(
      trendGraphs,
      buildRow(
        trendGraphs,
        {
          id: rowId,
          calculatedAt: reqDate(doc, 'calculatedAt'),
          nodes: (jsonArray(doc, 'nodes') ?? []) as StoredTrendGraphNode[],
          edges: (jsonArray(doc, 'edges') ?? []) as TrendGraphEdgeDTO[],
          droppedEdges: int(doc, 'droppedEdges'),
        },
        rowId
      )
    );
  },
};

export const DISCOVERY_PLANS: readonly CollectionPlan[] = [
  trendingPlan,
  trendBatchesPlan,
  trendSummariesPlan,
  trendGraphsPlan,
  topicStatsPlan,
  authorFollowerSnapshotsPlan,
  gifsPlan,
  notificationsPlan,
  pushTokensPlan,
];
