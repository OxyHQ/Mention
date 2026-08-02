/**
 * The two curated-account collections: `accountlists` (+ its members) and
 * `starterpacks` (+ its members and its uses).
 *
 * Both Mongo models are the same shape — a document carrying `memberOxyUserIds:
 * [String]` — and both become a parent row plus a junction. `starterpacks` adds
 * a second scalar array (`usedByOxyUserIds`) and an optional `source`
 * subdocument, which is where the two stop being the same problem.
 *
 * These plans also close the one legitimate UNPLANNED-PARENT edge left in the
 * schema: `custom_feed_source_lists.list_id` is a real foreign key to
 * `account_lists`, so until `accountlists` had a plan, a feed's source lists
 * referenced a table nothing filled.
 *
 * ## A member junction has TWO unique keys and they fail differently
 *
 * Both `account_list_members` and `starter_pack_members` declare
 * `(parent, oxy_user_id)` AND `(parent, position)`. The first says a member
 * appears once; the second says the ORDER is a bijection. A Mongo array
 * satisfies neither by construction — a duplicated id is legal there — so a
 * duplicate would violate the first key while shifting every later position, and
 * `ON CONFLICT DO NOTHING` would then leave a GAP in the second. Dedup happens
 * BEFORE positions are assigned, which is what keeps the surviving positions
 * dense. Same rule as `custom_feed_members`; stated here because it is the
 * property a future junction is most likely to be written without.
 *
 * ## `starter_pack_uses.created_at` is INVENTED, and which value it invents matters
 *
 * `usedByOxyUserIds` is a bare string array: Mongo never recorded WHEN a viewer
 * used a pack. The column is `NOT NULL DEFAULT now()`, so there is no way to
 * represent "unknown" — every migrated use row gets a timestamp that did not
 * exist before, and the only question is which one.
 *
 * Omitting the key lets the default apply, which stamps the MIGRATION's clock on
 * every historical use. That is not merely imprecise, it is wrong in a directed
 * way: it makes every migrated use look brand new, so the first surface anyone
 * writes that orders uses by recency ranks the entire imported set above every
 * genuine one. It is also not reproducible — two attempts of the same run write
 * different values for the same logical row.
 *
 * So the pack's own `createdAt` is used instead. It is a true LOWER BOUND (a use
 * cannot predate the pack) and a pure function of the source. Note the
 * difference from `poll_votes`, which derives `created_at` from the poll's
 * timestamp PLUS the ordinal: that offset exists because `PollVoteService` reads
 * the votes back in `created_at` order, and spacing them preserves it. Nothing
 * reads a use row's order — the only readers are a `NOT EXISTS` for the
 * recommendation exclusion (`routes/starterPacks.ts`) and the unique key — so
 * spacing these would manufacture an ordering no reader asked for. Do not
 * "harmonize" the two.
 *
 * ## `source` is a THIRD cross-column CHECK with no harmless direction
 *
 * `starter_packs_source_complete_check` is all-or-nothing over three flattened
 * columns, and like `threadgate_allow_rules_list_id_check` no audit kind in this
 * framework can express a predicate relating two columns. Unlike that one, there
 * is no direction to normalize toward:
 *
 * - Dropping a partial source makes an UPSTREAM-OWNED pack locally editable
 *   (the write API's read-only guard reads exactly this field) and destroys the
 *   dedup key, so the next atproto re-sync creates a SECOND Mention pack for the
 *   same remote one rather than updating in place.
 * - Filling in a missing field invents a provenance the source never recorded.
 *
 * Both are damage, so a partial source THROWS — the sanctioned refusal, naming
 * the constraint and carrying the Mongo query that counts every other instance,
 * because a throw stops at the first one where a finding would count them all.
 *
 * It should never fire. The only writer is `connectors/atproto/starterpack.mapper.ts`,
 * which sets `source: { network, uri, syncedAt }` as ONE subdocument inside a
 * `findOneAndUpdate` upsert, so the three fields arrive or are absent together;
 * Mongoose's `required: true` on each subschema path runs on `save()` regardless
 * of `runValidators`. The exposure is a hand-run `$set` on a single dotted path,
 * which is precisely the kind of row whose provenance nobody can reconstruct
 * later — hence a refusal rather than a guess.
 */

import {
  accountListMembers,
  accountLists,
  starterPackMembers,
  starterPackUses,
  starterPacks,
} from '../../schema/lists';
import type { CollectionPlan, Emit } from '../plan';
import { buildRow } from '../rowBuilder';
import {
  bool,
  childRowId,
  date,
  int,
  ownId,
  reqStr,
  str,
  strArray,
  type MongoDocument,
} from '../values';
import { timestamps } from './timestamps';

/** `accountlists` → `account_lists` + `account_list_members`. */
const accountListsPlan: CollectionPlan = {
  collection: 'accountlists',
  table: accountLists,
  childTables: [accountListMembers],
  numericAudits: [
    {
      path: 'subscriberCount',
      column: accountLists.subscriberCount,
      constraint: 'account_lists_subscriber_count_check',
      min: 0,
      absentAs: 0,
    },
  ],
  transform: (doc, emit) => {
    const listId = ownId(doc);

    emit(
      accountLists,
      buildRow(
        accountLists,
        {
          id: listId,
          ownerOxyUserId: reqStr(doc, 'ownerOxyUserId'),
          title: reqStr(doc, 'title'),
          description: str(doc, 'description'),
          isPublic: bool(doc, 'isPublic') ?? true,
          // Denormalized; `entity_follows` where `entity_type = 'list'` is the
          // authority. Copied verbatim rather than recomputed — recomputing
          // would repair drift on the way past and hide that it had drifted.
          subscriberCount: int(doc, 'subscriberCount') ?? 0,
          ...timestamps(doc),
        },
        listId
      )
    );

    emitMembers(doc, emit, {
      table: accountListMembers,
      parentColumn: 'listId',
      parentId: listId,
    });
  },
};

/** `starterpacks` → `starter_packs` + `starter_pack_members` + `starter_pack_uses`. */
const starterPacksPlan: CollectionPlan = {
  collection: 'starterpacks',
  table: starterPacks,
  childTables: [starterPackMembers, starterPackUses],
  enumAudits: [{ path: 'source.network', column: starterPacks.sourceNetwork }],
  numericAudits: [
    {
      path: 'useCount',
      column: starterPacks.useCount,
      constraint: 'starter_packs_use_count_check',
      // Worth auditing even though `account_lists.subscriberCount` above looks
      // identical: that field at least DECLARES `min: 0` in Mongo, while this
      // one declares nothing at all. Neither declaration was ever enforced
      // (`runValidators` is set nowhere in this package), so both can be
      // negative — but this is the one where nobody ever intended a floor.
      min: 0,
      absentAs: 0,
    },
  ],
  uniquenessAudits: [
    {
      index: 'starter_packs_source_uri_key',
      key: [{ path: 'source.uri', normalize: 'exact' }],
      // The index is PARTIAL (`where source_uri is not null`), and its predicate
      // is exactly the NULLS DISTINCT presence filter `auditUniqueness` already
      // applies — so this line is REDUNDANT, and that is measured rather than
      // assumed: deleting it leaves the suite green, and so does deleting the
      // presence filter instead. Only deleting BOTH turns
      // `backfillListPlans.test.ts`'s "does NOT report the packs that carry no
      // source at all" red. So no test discriminates this declaration, and it is
      // kept anyway for the reason `UniquenessAudit.where` gives — a partial
      // index's predicate is not optional, and relying on the framework's
      // presence filter would make this audit correct only by the coincidence of
      // two mechanisms agreeing. Mongo's own index is `sparse: true`, the same
      // predicate in Mongo's spelling.
      where: { 'source.uri': { $nin: [null, undefined] } },
    },
  ],
  transform: (doc, emit) => {
    const packId = ownId(doc);
    const source = sourceColumns(doc, packId);

    emit(
      starterPacks,
      buildRow(
        starterPacks,
        {
          id: packId,
          ownerOxyUserId: reqStr(doc, 'ownerOxyUserId'),
          name: reqStr(doc, 'name'),
          description: str(doc, 'description'),
          // Denormalized alongside `starter_pack_uses`; the rows are the
          // authority. Copied, not recomputed — same reason as above, and here
          // the two can genuinely disagree because Mongo incremented `useCount`
          // and pushed onto `usedByOxyUserIds` as separate operations.
          useCount: int(doc, 'useCount') ?? 0,
          ...source,
          ...timestamps(doc),
        },
        packId
      )
    );

    emitMembers(doc, emit, {
      table: starterPackMembers,
      parentColumn: 'packId',
      parentId: packId,
    });
    emitUses(doc, packId, emit);
  },
};

/** Which junction a member array feeds, and under what column name. */
interface MemberTarget {
  readonly table: typeof accountListMembers | typeof starterPackMembers;
  readonly parentColumn: 'listId' | 'packId';
  readonly parentId: string;
}

/**
 * `memberOxyUserIds[]` → a member junction, deduped BEFORE positions.
 *
 * Shared by both plans because the two tables are the same table under two
 * names — same columns, same pair of unique keys, same failure if the dedup and
 * the positioning are done in the wrong order (see the module docblock).
 */
function emitMembers(doc: MongoDocument, emit: Emit, target: MemberTarget): void {
  const seen = new Set<string>();
  let position = 0;
  for (const oxyUserId of strArray(doc, 'memberOxyUserIds') ?? []) {
    if (seen.has(oxyUserId)) continue;
    seen.add(oxyUserId);
    emit(
      target.table,
      buildRow(
        target.table,
        {
          id: childRowId({}, target.parentId, 'memberOxyUserIds', position),
          [target.parentColumn]: target.parentId,
          oxyUserId,
          position,
        },
        target.parentId
      )
    );
    position += 1;
  }
}

/**
 * `usedByOxyUserIds[]` → `starter_pack_uses`.
 *
 * No `position` column — the key is `(pack_id, oxy_user_id)` and a use is a SET
 * membership, so order never meant anything. `created_at` comes from the pack;
 * see the module docblock for why that beats letting the default apply.
 */
function emitUses(doc: MongoDocument, packId: string, emit: Emit): void {
  const packCreatedAt = date(doc, 'createdAt');
  const seen = new Set<string>();
  let ordinal = 0;
  for (const oxyUserId of strArray(doc, 'usedByOxyUserIds') ?? []) {
    if (seen.has(oxyUserId)) continue;
    seen.add(oxyUserId);
    emit(
      starterPackUses,
      buildRow(
        starterPackUses,
        {
          id: childRowId({}, packId, 'usedByOxyUserIds', ordinal),
          packId,
          oxyUserId,
          // Omitted when the pack itself has no `createdAt` — a document that
          // predates `{ timestamps: true }`. The default then applies, which is
          // the migration's clock; there is nothing better to reach for, and
          // saying so is better than reaching for the clock deliberately.
          ...(packCreatedAt === null ? {} : { createdAt: packCreatedAt }),
        },
        packId
      )
    );
    ordinal += 1;
  }
}

/**
 * The `source` subdocument, flattened — all three columns or all three NULL.
 *
 * @throws {Error} On a PARTIAL source. See the module docblock for why there is
 *   no direction to normalize toward, and why this is a refusal rather than an
 *   audit finding.
 */
function sourceColumns(doc: MongoDocument, packId: string): Record<string, unknown> {
  const network = str(doc, 'source.network');
  const uri = str(doc, 'source.uri');
  const syncedAt = date(doc, 'source.syncedAt');

  const present = [network, uri, syncedAt].filter((value) => value !== null).length;
  if (present !== 0 && present !== 3) {
    throw new Error(
      `starterpacks ${packId}: source is PARTIAL (network=${network === null ? 'absent' : 'set'}, ` +
        `uri=${uri === null ? 'absent' : 'set'}, syncedAt=${syncedAt === null ? 'absent' : 'set'}), ` +
        'and starter_packs_source_complete_check requires all three or none. ' +
        'Dropping the fragment would make an upstream-owned pack locally ' +
        'editable and let the next atproto sync create a duplicate; inventing ' +
        'the missing one would assert a provenance the source never recorded. ' +
        'Count every instance with: db.starterpacks.countDocuments({ $or: [ ' +
        "{ 'source.network': { $exists: true }, 'source.uri': { $exists: false } }, " +
        "{ 'source.network': { $exists: true }, 'source.syncedAt': { $exists: false } }, " +
        "{ 'source.uri': { $exists: true }, 'source.network': { $exists: false } }, " +
        "{ 'source.syncedAt': { $exists: true }, 'source.network': { $exists: false } } ] })"
    );
  }

  return { sourceNetwork: network, sourceUri: uri, sourceSyncedAt: syncedAt };
}

/** Both list plans. */
export const LIST_PLANS: readonly CollectionPlan[] = [accountListsPlan, starterPacksPlan];
