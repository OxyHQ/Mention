/**
 * The feed surfaces: `customfeeds` (+ four child tables), `feedgenerators`,
 * `feedlikes`, `feedreviews`, `feedinteractions`, `userfeedpreferences` (+ its
 * saved-feed layout).
 *
 * The last WIDE fan-out in the migration — `customfeeds` alone produces rows in
 * five tables from four different Mongo shapes, and each shape is flattened for
 * a different reason:
 *
 * | Mongo | table | why it is rows |
 * |---|---|---|
 * | `definition.{sources,signals,filters}[]` | `custom_feed_definition_modules` | three arrays of `ModuleRef`, one table with a `kind` discriminator |
 * | `memberOxyUserIds[]` | `custom_feed_members` | scalar array, ORDERED (`position` is unique per feed) |
 * | `sourceListIds[]` | `custom_feed_source_lists` | scalar array, a real foreign key to `account_lists` |
 * | `topicIds[]` | `custom_feed_topics` | scalar array of Oxy Topic ids, no foreign key |
 *
 * ## `custom_feed_members` has TWO unique keys and they mean different things
 *
 * `(feed_id, oxy_user_id)` says a member appears once; `(feed_id, position)`
 * says the ORDER is a bijection. Mongo's `memberOxyUserIds` array satisfies
 * neither by construction — a duplicated id is legal there — so a duplicate in
 * the source would violate the first key while shifting every later position,
 * and `ON CONFLICT DO NOTHING` would then leave a GAP in the second. Dedup
 * happens before positions are assigned, so the surviving positions stay dense.
 *
 * ## `params` is the only genuinely shape-less value here
 *
 * A module's parameters are defined by the MODULE, not by the feed engine, so
 * there is no shape to project into columns. Everything else on a `ModuleRef`
 * has a known type and gets a real column.
 *
 * ## `definitionMode` NULL is meaningful, not missing
 *
 * A feed with no stored `definition` predates the composable-definition phase,
 * and the request-time fallback derives one from the legacy filter fields
 * (`keywords`, `includeReplies`, …) that are still copied alongside. So NULL
 * must survive: defaulting it to `'ranked'` would silently switch those feeds
 * off the fallback and onto an empty module list.
 */

import {
  customFeedDefinitionModules,
  customFeedMembers,
  customFeedSourceLists,
  customFeedTopics,
  customFeeds,
  feedGenerators,
  feedInteractions,
  feedLikes,
  feedReviews,
  userFeedPreferences,
  userSavedFeeds,
} from '../../schema/feeds';
import type { CollectionPlan, Emit } from '../plan';
import { buildRow } from '../rowBuilder';
import {
  bool,
  childRowId,
  date,
  int,
  jsonObject,
  num,
  ownId,
  reqId,
  reqBool,
  reqInt,
  reqStr,
  str,
  strArray,
  subdocuments,
  type MongoDocument,
} from '../values';
import { timestamps } from './timestamps';

/** The three `ModuleRef` arrays, and the `kind` each becomes. */
const MODULE_KINDS = [
  ['definition.sources', 'source'],
  ['definition.signals', 'signal'],
  ['definition.filters', 'filter'],
] as const;

/** `customfeeds` → `custom_feeds` + four child tables. */
const customFeedsPlan: CollectionPlan = {
  collection: 'customfeeds',
  table: customFeeds,
  childTables: [
    customFeedDefinitionModules,
    customFeedMembers,
    customFeedSourceLists,
    customFeedTopics,
  ],
  enumAudits: [
    // Both NULLABLE, and both CHECKs are `is null or in (…)` for that reason —
    // the audit's null branch declines a null and reports only a real value the
    // column does not accept.
    { path: 'definition.mode', column: customFeeds.definitionMode },
    { path: 'category', column: customFeeds.category },
    // `custom_feed_definition_modules.kind` is NOT audited, and that is checked
    // rather than forgotten: the transform ASSIGNS it from which of the three
    // arrays a module came out of, so it is correct by construction. Auditing
    // it would compare the free-form `module` NAME against the kind vocabulary
    // and report every module in production as illegal — a gate that fires on
    // healthy data is worse than none.
  ],
  numericAudits: [
    {
      path: 'subscriberCount',
      column: customFeeds.subscriberCount,
      constraint: 'custom_feeds_counts_check',
      min: 0,
      absentAs: 0,
    },
    {
      path: 'ratingsCount',
      column: customFeeds.ratingsCount,
      constraint: 'custom_feeds_counts_check',
      min: 0,
      absentAs: 0,
    },
    {
      path: 'averageRating',
      column: customFeeds.averageRating,
      constraint: 'custom_feeds_average_rating_check',
      // `between 0 and 5` — note the lower bound is 0, NOT the review rating's
      // 1. An unrated feed legitimately averages zero, and auditing it against
      // `feed_reviews`' floor would report every unrated feed as blocking.
      min: 0,
      max: 5,
      absentAs: 0,
    },
  ],
  transform: (doc, emit) => {
    const feedId = ownId(doc);

    emit(
      customFeeds,
      buildRow(
        customFeeds,
        {
          id: feedId,
          ownerOxyUserId: reqStr(doc, 'ownerOxyUserId'),
          title: reqStr(doc, 'title'),
          description: str(doc, 'description'),
          isPublic: bool(doc, 'isPublic') ?? false,
          icon: str(doc, 'icon'),
          // NULL is MEANINGFUL — see the module docblock.
          definitionMode: str(doc, 'definition.mode'),
          keywords: strArray(doc, 'keywords'),
          includeReplies: bool(doc, 'includeReplies') ?? true,
          includeBoosts: bool(doc, 'includeBoosts') ?? true,
          includeMedia: bool(doc, 'includeMedia') ?? true,
          language: str(doc, 'language'),
          category: str(doc, 'category'),
          tags: strArray(doc, 'tags'),
          coverImage: str(doc, 'coverImage'),
          // Denormalized, and the ROWS are the authority: `subscriber_count` is
          // maintained by the `feed_likes` writer and `average_rating` /
          // `ratings_count` from `feed_reviews`. Copied verbatim rather than
          // recomputed — a migration that recomputed them would be repairing
          // data on the way past, which hides whether they had drifted.
          subscriberCount: int(doc, 'subscriberCount') ?? 0,
          averageRating: num(doc, 'averageRating') ?? 0,
          ratingsCount: int(doc, 'ratingsCount') ?? 0,
          ...timestamps(doc),
        },
        feedId
      )
    );

    emitModules(doc, feedId, emit);
    emitMembers(doc, feedId, emit);
    emitSourceLists(doc, feedId, emit);
    emitTopics(doc, feedId, emit);
  },
};

/**
 * The three `ModuleRef` arrays → one table, discriminated by `kind`.
 *
 * `position` restarts per KIND, because the unique key is
 * `(feed_id, kind, position)` — the three lists are independently ordered and
 * a single running counter would leave the second and third starting at an
 * offset that means nothing.
 */
function emitModules(doc: MongoDocument, feedId: string, emit: Emit): void {
  for (const [path, kind] of MODULE_KINDS) {
    for (const [module, position] of subdocuments(doc, path)) {
      emit(
        customFeedDefinitionModules,
        buildRow(
          customFeedDefinitionModules,
          {
            id: childRowId(module, feedId, path, position),
            feedId,
            kind,
            position,
            module: reqStr(module, 'module'),
            // `required: true` in Mongo with no default, and NOT NULL here —
            // so an absent one is a loud failure rather than an invented
            // `true`, which would silently switch a disabled module on.
            enabled: reqBool(module, 'enabled', feedId),
            // The ONE shape-less value in this schema. See the docblock.
            params: jsonObject(module, 'params'),
            weight: num(module, 'weight'),
          },
          feedId
        )
      );
    }
  }
}

/**
 * `memberOxyUserIds[]` → `custom_feed_members`, deduped BEFORE positions.
 *
 * Two unique keys apply and they fail differently — see the module docblock.
 * Deduping first is what keeps the surviving `position` values dense; deduping
 * after would leave a gap wherever a duplicate was removed.
 */
function emitMembers(doc: MongoDocument, feedId: string, emit: Emit): void {
  const seen = new Set<string>();
  let position = 0;
  for (const oxyUserId of strArray(doc, 'memberOxyUserIds') ?? []) {
    if (seen.has(oxyUserId)) continue;
    seen.add(oxyUserId);
    emit(
      customFeedMembers,
      buildRow(
        customFeedMembers,
        {
          id: childRowId({}, feedId, 'memberOxyUserIds', position),
          feedId,
          oxyUserId,
          position,
        },
        feedId
      )
    );
    position += 1;
  }
}

/**
 * `sourceListIds[]` → `custom_feed_source_lists`.
 *
 * The one child here with a REAL foreign key (`account_lists.id`), so a feed
 * naming a deleted list becomes a referential finding rather than a silently
 * dead source. No `position` column: the key is `(feed_id, list_id)` and the
 * sources are a SET — order never meant anything for them.
 */
function emitSourceLists(doc: MongoDocument, feedId: string, emit: Emit): void {
  const seen = new Set<string>();
  for (const [index, listId] of (strArray(doc, 'sourceListIds') ?? []).entries()) {
    if (seen.has(listId)) continue;
    seen.add(listId);
    emit(
      customFeedSourceLists,
      buildRow(
        customFeedSourceLists,
        {
          id: childRowId({}, feedId, 'sourceListIds', index),
          feedId,
          listId,
        },
        feedId
      )
    );
  }
}

/** `topicIds[]` → `custom_feed_topics`. Oxy Topic ids; no foreign key. */
function emitTopics(doc: MongoDocument, feedId: string, emit: Emit): void {
  const seen = new Set<string>();
  for (const [index, topicId] of (strArray(doc, 'topicIds') ?? []).entries()) {
    if (seen.has(topicId)) continue;
    seen.add(topicId);
    emit(
      customFeedTopics,
      buildRow(
        customFeedTopics,
        {
          id: childRowId({}, feedId, 'topicIds', index),
          feedId,
          topicId,
        },
        feedId
      )
    );
  }
}

/** `feedgenerators` → `feed_generators`. The `source` subdocument flattens. */
const feedGeneratorsPlan: CollectionPlan = {
  collection: 'feedgenerators',
  table: feedGenerators,
  enumAudits: [{ path: 'source.network', column: feedGenerators.sourceNetwork }],
  uniquenessAudits: [
    { index: 'feed_generators_uri_key', key: [{ path: 'uri', normalize: 'exact' }] },
  ],
  transform: (doc, emit) => {
    emit(
      feedGenerators,
      buildRow(
        feedGenerators,
        {
          id: ownId(doc),
          uri: reqStr(doc, 'uri'),
          name: reqStr(doc, 'name'),
          description: str(doc, 'description'),
          avatar: str(doc, 'avatar'),
          algorithm: reqStr(doc, 'algorithm'),
          createdBy: reqStr(doc, 'createdBy'),
          likeCount: int(doc, 'likeCount') ?? 0,
          subscriberCount: int(doc, 'subscriberCount') ?? 0,
          // All three are absent together on a NATIVE generator and present
          // together on one synced from Bluesky — the subdocument is optional
          // as a whole. Nothing enforces that triple in the schema, so a
          // half-written one would survive; it is copied as-is rather than
          // normalized, because inventing a `network` for a row that has a
          // `serviceDid` would assert a provenance the source never recorded.
          sourceNetwork: str(doc, 'source.network'),
          sourceServiceDid: str(doc, 'source.serviceDid'),
          sourceSyncedAt: date(doc, 'source.syncedAt'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** `feedlikes` → `feed_likes`. The live subscription mechanism. */
const feedLikesPlan: CollectionPlan = {
  collection: 'feedlikes',
  table: feedLikes,
  uniquenessAudits: [
    {
      index: 'feed_likes_user_id_feed_id_key',
      key: [
        { path: 'userId', normalize: 'exact' },
        { path: 'feedId', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    emit(
      feedLikes,
      buildRow(
        feedLikes,
        {
          id: ownId(doc),
          userId: reqStr(doc, 'userId'),
          // A real `ObjectId` in Mongo (`ref: 'CustomFeed'`), so `reqId` rather
          // than `reqStr` — and a real foreign key here.
          feedId: reqId(doc, 'feedId'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** `feedreviews` → `feed_reviews`. One rating per (feed, reviewer). */
const feedReviewsPlan: CollectionPlan = {
  collection: 'feedreviews',
  table: feedReviews,
  numericAudits: [
    {
      path: 'rating',
      column: feedReviews.rating,
      constraint: 'feed_reviews_rating_check',
      // `between 1 and 5`, and the floor is 1 here unlike `custom_feeds.
      // average_rating`'s 0 — a review with no stars is not a review, whereas
      // an unrated feed genuinely averages zero.
      min: 1,
      max: 5,
    },
  ],
  uniquenessAudits: [
    {
      index: 'feed_reviews_feed_id_reviewer_id_key',
      key: [
        { path: 'feedId', normalize: 'exact' },
        { path: 'reviewerId', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    emit(
      feedReviews,
      buildRow(
        feedReviews,
        {
          id: ownId(doc),
          feedId: reqId(doc, 'feedId'),
          reviewerId: reqStr(doc, 'reviewerId'),
          rating: reqInt(doc, 'rating'),
          reviewText: str(doc, 'reviewText'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/**
 * `feedinteractions` → `feed_interactions`.
 *
 * TTL-reaped in Mongo on a 90-day window and swept on the same window here
 * (`db/expiry.ts`), so the source is shrinking underneath the run — a document
 * counted at discovery can be gone before the stream reaches it. That is not a
 * fault and it means the verifier's count can legitimately come out short on
 * this collection after a long run.
 */
const feedInteractionsPlan: CollectionPlan = {
  collection: 'feedinteractions',
  table: feedInteractions,
  enumAudits: [{ path: 'event', column: feedInteractions.event }],
  transform: (doc, emit) => {
    emit(
      feedInteractions,
      buildRow(
        feedInteractions,
        {
          id: ownId(doc),
          userId: reqStr(doc, 'userId'),
          // Client-supplied and validated before use, so no foreign key — a
          // stale descriptor must degrade to "matches nothing", not to a 500.
          feedDescriptor: reqStr(doc, 'feedDescriptor'),
          postUri: reqStr(doc, 'postUri'),
          event: reqStr(doc, 'event'),
          durationMs: int(doc, 'durationMs'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/**
 * `userfeedpreferences` → `user_feed_preferences` + `user_saved_feeds`.
 *
 * The parent row carries nothing but the owner: every field of the preference
 * IS the saved-feed layout, which becomes child rows. A user with an empty
 * layout still gets a parent row, because the row is what says the user has
 * been through the feed picker at all.
 */
const userFeedPreferencesPlan: CollectionPlan = {
  collection: 'userfeedpreferences',
  table: userFeedPreferences,
  childTables: [userSavedFeeds],
  uniquenessAudits: [
    {
      index: 'user_feed_preferences_oxy_user_id_key',
      key: [{ path: 'oxyUserId', normalize: 'exact' }],
    },
  ],
  transform: (doc, emit) => {
    const preferenceId = ownId(doc);

    emit(
      userFeedPreferences,
      buildRow(
        userFeedPreferences,
        {
          id: preferenceId,
          oxyUserId: reqStr(doc, 'oxyUserId'),
          ...timestamps(doc),
        },
        preferenceId
      )
    );

    // `SavedFeedSchema` is `{ _id: false }`, so these ids are DERIVED. The
    // unique key is `(preference_id, key)` — the schema's own comment says a
    // saved feed "is identified by its `key`, not an ObjectId" — so the id is
    // derived from the ARRAY ORDINAL while the KEY is what enforces identity.
    // Deduping on the key keeps the emitted count equal to what the table can
    // hold, which is what the verifier compares against.
    const seen = new Set<string>();
    for (const [saved, position] of subdocuments(doc, 'savedFeeds')) {
      const key = reqStr(saved, 'key');
      if (seen.has(key)) continue;
      seen.add(key);
      emit(
        userSavedFeeds,
        buildRow(
          userSavedFeeds,
          {
            id: childRowId(saved, preferenceId, 'savedFeeds', position),
            preferenceId,
            key,
            descriptor: reqStr(saved, 'descriptor'),
            pinned: bool(saved, 'pinned') ?? false,
            // The DISPLAY order the user arranged, which is a different thing
            // from the array ordinal — Mongo stored it explicitly and a
            // reordered layout rewrites it without moving array elements.
            order: int(saved, 'order') ?? 0,
          },
          preferenceId
        )
      );
    }
  },
};

/** Every feed plan. */
export const FEED_PLANS: readonly CollectionPlan[] = [
  customFeedsPlan,
  feedGeneratorsPlan,
  feedLikesPlan,
  feedReviewsPlan,
  feedInteractionsPlan,
  userFeedPreferencesPlan,
];
