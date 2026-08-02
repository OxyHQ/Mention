/**
 * Engagement: the seven collections that are one document, one row.
 *
 * `likes` `bookmarks` `postsubscriptions` `pokes` `mutes` `mutewords`
 * `entityfollows` — no subdocument arrays, no child tables, and (with one
 * exception) no decisions. They are written first because they establish the
 * shape the other forty plans follow, and because two of them (`likes`,
 * `bookmarks`) reference `posts`, which is what makes the level ordering do
 * real work rather than being trivially satisfied.
 *
 * ## `createdAt` / `updatedAt` are COPIED, never defaulted
 *
 * Both columns carry a database default, so omitting them would silently stamp
 * every migrated row with the migration's own clock — destroying the history
 * the migration exists to preserve. `schema/CONVENTIONS.md` names that hazard
 * as the reason `updated_at` is maintained by the application rather than a
 * trigger. So the source value is written when present, and the key is OMITTED
 * (never `null`) when absent, which is the only way to let the default apply
 * for a `NOT NULL` column.
 *
 * `pokes` and `mutes` are the two models with no `{ timestamps: true }` — they
 * declare `createdAt` by hand and have no `updatedAt` at all, and their tables
 * match. Reading an `updatedAt` off them would invent one.
 *
 * ## The numeric CHECKs ARE audited — the earlier note here was wrong
 *
 * A previous version of this comment said `likes.value` (`in (1, -1)`) and
 * `likes.revision` (`>= 0`) could not be checked before the copy, because
 * `EnumAudit` reads its allowed set from a drizzle column's `enumValues` and no
 * numeric column carries one. The framework half of that was true; the verdict
 * was not. `distinct()` is the same instrument the enum audit uses and returns
 * numbers as readily as strings, so `auditNumerics` (`../audit.ts`) now covers
 * both, and a `value: 0` row is reported before anything is written rather than
 * failing on the CHECK partway through.
 *
 * `likes.value`'s accepted set is `LIKE_VALUES`, imported from the schema — the
 * same tuple the CHECK is now rendered from, so the audit predicts the
 * constraint rather than a copy of it. `revision >= 0` is a BOUND, and a bound
 * has no structured form to read: it is declared on the audit beside the
 * constraint name it claims to predict, which is weaker and is worth knowing.
 *
 * Every TEXT enum in this file is audited too.
 */

import {
  bookmarks,
  entityFollows,
  LIKE_VALUES,
  likes,
  muteWords,
  mutes,
  pokes,
  postSubscriptions,
} from '../../schema/engagement';
import { allowedValues, type CollectionPlan } from '../plan';
import { DROP_UNREAD_FEED_ENTITY_FOLLOWS } from '../resolutions';
import { buildRow } from '../rowBuilder';
import { date, int, ownId, reqId, reqStr, str, strArray } from '../values';

/**
 * The entity kinds `entity_follows` still accepts.
 *
 * Imported from the SCHEMA rather than the model so the audit and the CHECK
 * cannot disagree — they are the same constant. Both happen to declare
 * `['hashtag','list']`, and that agreement is exactly what makes the live
 * `'feed'` rows below surprising until you remember Mongoose never ran
 * `runValidators`.
 */
export { ENTITY_FOLLOW_TYPES } from '../../schema/engagement';

/** `likes` → `likes`. */
const likesPlan: CollectionPlan = {
  collection: 'likes',
  table: likes,
  numericAudits: [
    {
      path: 'value',
      column: likes.value,
      constraint: 'likes_value_check',
      // From the schema's own tuple — the SAME one the CHECK renders from, so
      // this predicts the constraint instead of a second copy of it.
      values: LIKE_VALUES,
      // The transform re-applies Mongoose's `default: 1`, so a document written
      // before the field existed is not a finding.
      absentAs: 1,
    },
    {
      path: 'revision',
      column: likes.revision,
      constraint: 'likes_revision_check',
      // A BOUND, not a set, and it is declared rather than read: `>= 0` lives
      // inline in the CHECK and drizzle exposes no structured form of it. The
      // constraint name above is what ties the declaration to the thing it
      // claims to predict.
      //
      // `0` and not `1` deliberately. Mongoose says `min: 1`; the CHECK was
      // widened to `>= 0` because legacy rows start at zero and take revision 1
      // on their next transition. Auditing against the model's stricter claim
      // would report every legacy row as blocking, which is the shape of gate
      // that gets disabled by whoever hits it next.
      min: 0,
      absentAs: 1,
    },
  ],
  uniquenessAudits: [
    {
      index: 'likes_user_id_post_id_key',
      key: [
        { path: 'userId', normalize: 'exact' },
        { path: 'postId', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    emit(
      likes,
      buildRow(
        likes,
        {
          id: ownId(doc),
          userId: reqStr(doc, 'userId'),
          postId: reqId(doc, 'postId'),
          // `default: 1` in Mongoose applies on WRITE, so a document that
          // predates the field has none at all — the default is re-applied here
          // rather than letting a NOT NULL column take a null.
          value: int(doc, 'value') ?? 1,
          // Mongoose says `min: 1`; the CHECK says `>= 0`, because legacy rows
          // start at zero and take revision 1 on their next transition. The
          // source value is copied verbatim either way — narrowing it here
          // would rewrite history to match a constraint that was widened
          // deliberately to accommodate it.
          revision: int(doc, 'revision') ?? 1,
          source: str(doc, 'source'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** `bookmarks` → `bookmarks`. */
const bookmarksPlan: CollectionPlan = {
  collection: 'bookmarks',
  table: bookmarks,
  uniquenessAudits: [
    {
      index: 'bookmarks_user_id_post_id_key',
      key: [
        { path: 'userId', normalize: 'exact' },
        { path: 'postId', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    emit(
      bookmarks,
      buildRow(
        bookmarks,
        {
          id: ownId(doc),
          userId: reqStr(doc, 'userId'),
          postId: reqId(doc, 'postId'),
          // NULL means the default (unfiled) folder, and it must stay NULL
          // rather than becoming `''` — an empty string is a VALUE, so it would
          // become a folder literally named "". `str` returns null for absent,
          // which is the same answer Mongo's `default: null` gives.
          folder: str(doc, 'folder'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** `postsubscriptions` → `post_subscriptions`. */
const postSubscriptionsPlan: CollectionPlan = {
  collection: 'postsubscriptions',
  table: postSubscriptions,
  uniquenessAudits: [
    {
      index: 'post_subscriptions_subscriber_id_author_id_key',
      key: [
        { path: 'subscriberId', normalize: 'exact' },
        { path: 'authorId', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    emit(
      postSubscriptions,
      buildRow(
        postSubscriptions,
        {
          id: ownId(doc),
          subscriberId: reqStr(doc, 'subscriberId'),
          authorId: reqStr(doc, 'authorId'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** `pokes` → `pokes`. No `updatedAt`: the model declares no timestamps. */
const pokesPlan: CollectionPlan = {
  collection: 'pokes',
  table: pokes,
  uniquenessAudits: [
    {
      index: 'pokes_poker_id_poked_id_key',
      key: [
        { path: 'pokerId', normalize: 'exact' },
        { path: 'pokedId', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    emit(
      pokes,
      buildRow(
        pokes,
        {
          id: ownId(doc),
          pokerId: reqStr(doc, 'pokerId'),
          pokedId: reqStr(doc, 'pokedId'),
          ...createdOnly(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** `mutes` → `mutes`. No `updatedAt`: the model declares no timestamps. */
const mutesPlan: CollectionPlan = {
  collection: 'mutes',
  table: mutes,
  uniquenessAudits: [
    {
      index: 'mutes_user_id_muted_id_key',
      key: [
        { path: 'userId', normalize: 'exact' },
        { path: 'mutedId', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    emit(
      mutes,
      buildRow(
        mutes,
        {
          id: ownId(doc),
          userId: reqStr(doc, 'userId'),
          mutedId: reqStr(doc, 'mutedId'),
          ...createdOnly(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** `mutewords` → `mute_words`. */
const muteWordsPlan: CollectionPlan = {
  collection: 'mutewords',
  table: muteWords,
  enumAudits: [
    // `targets` is an ARRAY of enum values and this audit checks a scalar path,
    // so it is deliberately NOT audited here — `distinct` on an array path
    // returns the ELEMENTS, which happens to be exactly right, so it is
    // included and reads each element against the column's own allowed set.
    { path: 'actorTarget', column: muteWords.actorTarget, absentAs: 'all' },
  ],
  uniquenessAudits: [
    {
      index: 'mute_words_user_id_value_key',
      key: [
        { path: 'userId', normalize: 'exact' },
        { path: 'value', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    emit(
      muteWords,
      buildRow(
        muteWords,
        {
          id: ownId(doc),
          userId: reqStr(doc, 'userId'),
          value: reqStr(doc, 'value'),
          // The column is `NOT NULL DEFAULT '{}'`, so an absent array becomes
          // an empty one HERE rather than through the default — making the
          // choice visible at the call site, which is why `strArray` returns
          // null instead of coalescing itself.
          targets: strArray(doc, 'targets') ?? [],
          actorTarget: str(doc, 'actorTarget') ?? 'all',
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** `entityfollows` → `entity_follows`, minus the retired `'feed'` rows. */
const entityFollowsPlan: CollectionPlan = {
  collection: 'entityfollows',
  table: entityFollows,
  enumAudits: [
    // This is what REPORTS the `'feed'` rows before anything is copied. The
    // rule below is what answers the finding; without the audit it would be a
    // silent removal, which is the whole thing `resolutions.ts` refuses to be.
    {
      path: 'entityType',
      column: entityFollows.entityType,
      resolvedBy: DROP_UNREAD_FEED_ENTITY_FOLLOWS,
    },
  ],
  uniquenessAudits: [
    {
      index: 'entity_follows_user_id_entity_type_entity_id_key',
      key: [
        { path: 'userId', normalize: 'exact' },
        { path: 'entityType', normalize: 'exact' },
        { path: 'entityId', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit, resolutions) => {
    const id = ownId(doc);
    const entityType = reqStr(doc, 'entityType');

    // NARROW BY CONSTRUCTION: only a value the column does not accept is
    // dropped, and the accepted set is read from the column rather than
    // restated. A future third legal type is copied, not discarded.
    if (!allowedValues(entityFollows.entityType).includes(entityType)) {
      resolutions.dropDocument(
        DROP_UNREAD_FEED_ENTITY_FOLLOWS,
        'entityfollows',
        id,
        `entityType ${JSON.stringify(entityType)} is not one of ` +
          `${allowedValues(entityFollows.entityType).join(' | ')}. The row is dropped; ` +
          'nothing reads it. See the rule for why this is a removal and not a ' +
          'schema widening.'
      );
      return;
    }

    emit(
      entityFollows,
      buildRow(
        entityFollows,
        {
          id,
          userId: reqStr(doc, 'userId'),
          entityType,
          entityId: reqStr(doc, 'entityId'),
          ...timestamps(doc),
        },
        id
      )
    );
  },
};

/**
 * `created_at` + `updated_at`, copied when present and OMITTED when absent.
 *
 * Omitting is not the same as `null`: both columns are `NOT NULL` with a
 * default, so a null would be refused while an omission lets the default apply.
 * `buildRow` rejects `undefined` for exactly this reason — the transform has to
 * choose, and this is where it chooses.
 */
function timestamps(doc: Record<string, unknown>): Record<string, unknown> {
  const createdAt = date(doc, 'createdAt');
  const updatedAt = date(doc, 'updatedAt');
  return {
    ...(createdAt === null ? {} : { createdAt }),
    ...(updatedAt === null ? {} : { updatedAt }),
  };
}

/** {@link timestamps} for the two models that have no `updatedAt` at all. */
function createdOnly(doc: Record<string, unknown>): Record<string, unknown> {
  const createdAt = date(doc, 'createdAt');
  return createdAt === null ? {} : { createdAt };
}

/** Every engagement plan. */
export const ENGAGEMENT_PLANS: readonly CollectionPlan[] = [
  likesPlan,
  bookmarksPlan,
  postSubscriptionsPlan,
  pokesPlan,
  mutesPlan,
  muteWordsPlan,
  entityFollowsPlan,
];
