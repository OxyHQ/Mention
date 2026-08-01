/**
 * `account_lists` + `starter_packs` and their membership junctions.
 *
 * Both models held `memberOxyUserIds: [String]` — an array of ids, which the
 * migration contract turns into a junction table. That is not bookkeeping here:
 * `starterPackCuration.ts` runs `{ memberOxyUserIds: { $in: authorIds } }`
 * followed by `$unwind` and a two-level `$group`, i.e. it is already treating
 * the array as a join it cannot perform. With a junction that whole pipeline is
 * an ordinary `GROUP BY`.
 *
 * `subscriber_count` / `use_count` stay as maintained counters. They are not
 * "Mongo could not JOIN" leftovers: both are SORT keys
 * (`{ useCount: -1, createdAt: -1 }`, `{ isPublic: 1, category: 1, subscriberCount: -1 }`)
 * and a sort on a live `COUNT(*)` cannot use an index.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from './columns';

/** The external networks a list/pack can be mirrored FROM. */
export const EXTERNAL_LIST_NETWORKS = ['atproto'] as const;

/** `StarterPack` member cap, enforced by the write API. */
export const STARTER_PACK_MAX_MEMBERS = 150;

/** `account_lists` — a user-curated set of accounts, followable as a subscription. */
export const accountLists = pgTable(
  'account_lists',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    ownerOxyUserId: text().notNull(),
    title: text().notNull(),
    description: text(),
    isPublic: boolean().notNull().default(true),
    /**
     * Maintained by `ListSubscriptionService` on every list follow/unfollow.
     * The authority is `entity_follows` where `entity_type = 'list'`; this is
     * the projection the list DTO serves and the marketplace sorts on.
     */
    subscriberCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('account_lists_subscriber_count_check', sql`${t.subscriberCount} >= 0`),
    index('account_lists_owner_chrono_idx').on(t.ownerOxyUserId, t.createdAt.desc()),
    index('account_lists_public_chrono_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.isPublic}`),
  ]
);

/** `account_list_members` — the junction replacing `memberOxyUserIds`. */
export const accountListMembers = pgTable(
  'account_list_members',
  {
    id: generatedId(),
    listId: text()
      .notNull()
      .references(() => accountLists.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    /** Preserves the order the owner arranged the list in. */
    position: integer().notNull(),
  },
  (t) => [
    check('account_list_members_position_check', sql`${t.position} >= 0`),
    unique('account_list_members_list_id_oxy_user_id_key').on(t.listId, t.oxyUserId),
    unique('account_list_members_list_id_position_key').on(t.listId, t.position),
    // "Which lists is this account on" — the feed-merge direction.
    index('account_list_members_oxy_user_id_idx').on(t.oxyUserId),
  ]
);

/**
 * `starter_packs` — a curated pack a VIEWER follows through, one member at a
 * time or all at once. There is no "follow the pack" relationship.
 */
export const starterPacks = pgTable(
  'starter_packs',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    ownerOxyUserId: text().notNull(),
    name: text().notNull(),
    description: text(),
    /** Maintained alongside `starter_pack_uses`; the rows are the authority. */
    useCount: integer().notNull().default(0),
    /**
     * Provenance for a pack MIRRORED from an external network. A pack carrying
     * a source is OWNED UPSTREAM and read-only through Mention's write API.
     */
    sourceNetwork: text({ enum: EXTERNAL_LIST_NETWORKS }),
    /** The source pack's canonical AT-URI. The dedup key for re-sync. */
    sourceUri: text(),
    sourceSyncedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('starter_packs_use_count_check', sql`${t.useCount} >= 0`),
    check(
      'starter_packs_source_network_check',
      sql`${t.sourceNetwork} is null or ${t.sourceNetwork} in (${sql.raw(inList(EXTERNAL_LIST_NETWORKS))})`
    ),
    // Mongo stored `source` as a subdocument, so its three fields arrived or
    // were absent together. Flattened into columns they could diverge; the CHECK
    // restores the all-or-nothing the subdocument gave for free.
    check(
      'starter_packs_source_complete_check',
      sql`(${t.sourceNetwork} is null and ${t.sourceUri} is null and ${t.sourceSyncedAt} is null)
        or (${t.sourceNetwork} is not null and ${t.sourceUri} is not null and ${t.sourceSyncedAt} is not null)`
    ),
    // Mongo's `{ 'source.uri': 1 }, { unique: true, sparse: true }` — one Mention
    // pack per remote pack, which is what closes the concurrent-import race.
    uniqueIndex('starter_packs_source_uri_key')
      .on(t.sourceUri)
      .where(sql`${t.sourceUri} is not null`),
    index('starter_packs_owner_chrono_idx').on(t.ownerOxyUserId, t.createdAt.desc()),
    index('starter_packs_use_count_idx').on(t.useCount.desc(), t.createdAt.desc()),
  ]
);

/**
 * `starter_pack_members` — the junction replacing `memberOxyUserIds`.
 *
 * Mongo compounded the multikey member array with `useCount` to serve the
 * curation aggregation. The equivalent here leads with the member id, because
 * the curation query starts from a batch of feed authors and asks which packs
 * contain them.
 */
export const starterPackMembers = pgTable(
  'starter_pack_members',
  {
    id: generatedId(),
    packId: text()
      .notNull()
      .references(() => starterPacks.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    position: integer().notNull(),
  },
  (t) => [
    check('starter_pack_members_position_check', sql`${t.position} >= 0`),
    unique('starter_pack_members_pack_id_oxy_user_id_key').on(t.packId, t.oxyUserId),
    unique('starter_pack_members_pack_id_position_key').on(t.packId, t.position),
    // The curation entry point: "which packs curate these authors".
    index('starter_pack_members_oxy_user_id_idx').on(t.oxyUserId),
  ]
);

/**
 * `starter_pack_uses` — who has used this pack.
 *
 * Mongo's `usedByOxyUserIds: [String]`, used as a `$ne` exclusion when
 * recommending packs the viewer has not used. As a junction it is a NOT EXISTS,
 * and `use_count` above becomes a projection of its cardinality rather than an
 * independently incremented number that could drift from the array's length.
 */
export const starterPackUses = pgTable(
  'starter_pack_uses',
  {
    id: generatedId(),
    packId: text()
      .notNull()
      .references(() => starterPacks.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('starter_pack_uses_pack_id_oxy_user_id_key').on(t.packId, t.oxyUserId),
    // "Packs I have already used" — the recommendation exclusion.
    index('starter_pack_uses_oxy_user_id_idx').on(t.oxyUserId),
  ]
);
