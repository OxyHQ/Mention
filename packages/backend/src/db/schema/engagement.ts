/**
 * The engagement relationships: `likes`, `bookmarks`, `post_subscriptions`,
 * `pokes`, `mutes`, `mute_words`, `entity_follows`.
 *
 * Every one of these is a (user, thing) edge that Mongo stored as a document
 * with a compound unique index. The port is direct; the interesting parts are
 * the ON DELETE choices, which follow `deletePost`'s own best-effort cascade
 * (`controllers/posts.controller.ts:1741-1747`) — likes and bookmarks are
 * deleted with their post today, so they CASCADE.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, numericInList, updatedAt } from './columns';
import { posts } from './posts';

/** `Like.value` — an up-vote or a down-vote. */
export const LIKE_VALUES = [1, -1] as const;

/** The entity kinds a follow row may name. This declaration is the authority. */
export const ENTITY_FOLLOW_TYPES = ['hashtag', 'list'] as const;

/** `MuteWord.targets` element. */
export const MUTE_WORD_TARGETS = ['content', 'tag'] as const;

/** `MuteWord.actorTarget`. */
export const MUTE_WORD_ACTOR_TARGETS = ['all', 'exclude-following'] as const;

/** `MuteWord.value` length ceiling, from the Mongoose `maxlength`. */
const MUTE_WORD_MAX_LENGTH = 100;

/**
 * `likes` — an up-vote (`value: 1`) or down-vote (`value: -1`) on a post.
 *
 * `value` stays a smallint rather than becoming a boolean: it is a THREE-state
 * relationship in the command service (`1` / `-1` / no row), and the outbox
 * payload carries `previousValue`/`value` as the same numbers.
 */
export const likes = pgTable(
  'likes',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    userId: text().notNull(),
    postId: text()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    value: integer().notNull().default(1),
    /**
     * Monotonic relationship revision, the input to the deterministic outbox id.
     * Mongo's `min: 1, default: 1`, with legacy rows starting at zero — so the
     * CHECK is `>= 0`, not `>= 1`, and the code's own comment says why ("Legacy
     * rows start at zero and receive revision 1 on their next transition").
     */
    revision: integer().notNull().default(1),
    /**
     * The feed descriptor the like happened on (`videos`, `for_you`,
     * `author|<id>`). Surface-aware recommendation attribution. Absent on legacy
     * rows and on likes with no surface context.
     */
    source: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Rendered FROM `LIKE_VALUES` rather than restating it. The tuple existed
    // beside a CHECK that spelled the same two numbers out independently, so
    // nothing referenced it and neither side would have noticed the other
    // changing; the backfill's numeric audit now reads it, which turns that
    // latent drift into a live one. `numericInList` emits `1, -1`, byte-identical
    // to the applied DDL, so this is not a migration.
    check('likes_value_check', sql`${t.value} in (${sql.raw(numericInList(LIKE_VALUES))})`),
    check('likes_revision_check', sql`${t.revision} >= 0`),
    unique('likes_user_id_post_id_key').on(t.userId, t.postId),
    // Counting/listing likes BY POST — the likes-list endpoint and engagement
    // reconciliation. The compound above cannot serve it (wrong leading field).
    index('likes_post_id_idx').on(t.postId),
    // `friendsEngaged` scans "likes by these users in this window".
    index('likes_user_id_created_at_idx').on(t.userId, t.createdAt.desc()),
  ]
);

/** `bookmarks` — a user saved a post, optionally into a named folder. */
export const bookmarks = pgTable(
  'bookmarks',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    userId: text().notNull(),
    postId: text()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /**
     * NULL means the default (unfiled) folder. Mongo used `default: null` for
     * exactly this, and it must stay NULL rather than `''` — an empty string is
     * a VALUE, so it would become a folder literally named "".
     */
    folder: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('bookmarks_user_id_post_id_key').on(t.userId, t.postId),
    index('bookmarks_user_id_created_at_idx').on(t.userId, t.createdAt.desc()),
    // The saves-count reconciliation groups by post.
    index('bookmarks_post_id_idx').on(t.postId),
    // The folder list (`Bookmark.distinct('folder', { userId, folder: {$ne:null} })`).
    index('bookmarks_user_id_folder_idx')
      .on(t.userId, t.folder)
      .where(sql`${t.folder} is not null`),
  ]
);

/**
 * `post_subscriptions` — notify me about this AUTHOR's new posts.
 *
 * NOTE for the query phase: `deletePost` calls
 * `PostSubscription.deleteMany({ postId })`, but this model has no `postId`
 * field at all — it is `(subscriberId, authorId)`. That call has always matched
 * zero documents. It is dead code, not a relation, and must NOT be ported into
 * a cascade.
 */
export const postSubscriptions = pgTable(
  'post_subscriptions',
  {
    id: generatedId(),
    /** Oxy account ids — no foreign keys. */
    subscriberId: text().notNull(),
    authorId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('post_subscriptions_subscriber_id_author_id_key').on(t.subscriberId, t.authorId),
    // "Who subscribed to this author" — the notification fan-out direction.
    index('post_subscriptions_author_id_idx').on(t.authorId),
  ]
);

/** `pokes` — one active poke per ordered user pair. */
export const pokes = pgTable(
  'pokes',
  {
    id: generatedId(),
    /** Oxy account ids — no foreign keys. */
    pokerId: text().notNull(),
    pokedId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('pokes_poker_id_poked_id_key').on(t.pokerId, t.pokedId),
    index('pokes_poked_id_created_at_idx').on(t.pokedId, t.createdAt.desc()),
  ]
);

/** `mutes` — user A has muted user B. */
export const mutes = pgTable(
  'mutes',
  {
    id: generatedId(),
    /** Oxy account ids — no foreign keys. */
    userId: text().notNull(),
    mutedId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('mutes_user_id_muted_id_key').on(t.userId, t.mutedId),
    // The reverse direction ("who has muted me") — Mongo indexed it, keep it.
    index('mutes_muted_id_idx').on(t.mutedId),
  ]
);

/**
 * `mute_words` — a word or phrase muted from the viewer's feeds.
 *
 * `targets` stays a `text[]`: it is a small unordered set of two possible
 * values, never joined and never queried by element in SQL (the matcher loads
 * the whole row). `MuteWord` has no expiry field, so there is no sweep entry.
 *
 * Its vocabulary rides on the BASE column rather than living only in the CHECK,
 * for the reason spelled out on `posts.reply_permission`: `allowedValues()`
 * reads `baseColumn.enumValues`, so the bare `text().array()` spelling is not
 * auditable at all — and the DDL is identical.
 */
export const muteWords = pgTable(
  'mute_words',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    userId: text().notNull(),
    value: text().notNull(),
    targets: text({ enum: MUTE_WORD_TARGETS })
      .array()
      .notNull()
      .default(sql`array[]::text[]`),
    actorTarget: text({ enum: MUTE_WORD_ACTOR_TARGETS }).notNull().default('all'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'mute_words_actor_target_check',
      sql`${t.actorTarget} in (${sql.raw(inList(MUTE_WORD_ACTOR_TARGETS))})`
    ),
    check(
      'mute_words_targets_check',
      sql`${t.targets} <@ array[${sql.raw(inList(MUTE_WORD_TARGETS))}]::text[]`
    ),
    check('mute_words_value_length_check', sql`length(${t.value}) <= ${sql.raw(String(MUTE_WORD_MAX_LENGTH))}`),
    unique('mute_words_user_id_value_key').on(t.userId, t.value),
  ]
);

/**
 * `entity_follows` — following a hashtag, or SUBSCRIBING to a list.
 *
 * `ENTITY_FOLLOW_TYPES` is deliberately two values: rows with
 * `entityType: 'feed'` were written historically and read by nothing (a feed
 * subscription is a `FeedLike` row). The narrowed CHECK is a REMOVAL of Mongo
 * baggage, and it is the one place in this schema where the backfill must
 * actively drop rows rather than copy them — a legacy `'feed'` row would
 * otherwise fail the constraint.
 *
 * `entity_id` is polymorphic (a hashtag STRING or an `account_lists.id`), so it
 * carries no foreign key. That is a real cost: deleting a list leaves its
 * subscriptions behind, exactly as today. `ListSubscriptionService` already
 * tolerates a missing list.
 */
export const entityFollows = pgTable(
  'entity_follows',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    userId: text().notNull(),
    entityType: text({ enum: ENTITY_FOLLOW_TYPES }).notNull(),
    /** A hashtag string, or an `account_lists.id`. Polymorphic — no foreign key. */
    entityId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'entity_follows_entity_type_check',
      sql`${t.entityType} in (${sql.raw(inList(ENTITY_FOLLOW_TYPES))})`
    ),
    unique('entity_follows_user_id_entity_type_entity_id_key').on(
      t.userId,
      t.entityType,
      t.entityId
    ),
    // "Who follows this entity" — the subscriber-count maintenance direction.
    index('entity_follows_entity_idx').on(t.entityType, t.entityId),
    // "What does this user follow of this kind" — the feed-merge direction.
    index('entity_follows_user_type_idx').on(t.userId, t.entityType),
  ]
);
