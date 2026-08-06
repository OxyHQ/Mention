import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../db/schema';
import {
  CHANNEL_CASCADE,
  EMBEDDED_CHANNEL_REFERENCES,
  NOT_A_CHANNEL_REFERENCE,
  OWNED_BY_OXY,
} from '../../services/channelDeletion/channelCascadeManifest';

/**
 * Deleting a channel has to remove EVERYTHING that points at it. A cascade
 * written by hand satisfies that on the day it is written and then decays
 * silently: somebody adds a table with a `postId`, nothing references it from
 * the cascade, and rows keep pointing at a channel that no longer exists. There
 * is no error, no failing request and no log line — the first symptom is a
 * hydration miss months later.
 *
 * So the cascade is enumerated as data (`channelCascadeManifest.ts`) and this
 * test compares that data against the REAL schema. A new table carrying an
 * id-shaped column fails this test on the commit that adds it, and the failure
 * names the column and says which list to put it in.
 *
 * ## WHY THIS READS THE SCHEMA OBJECT AND NOT `src/models/*.ts`
 *
 * It used to scan the Mongoose model tree with a regex over source. Post-cutover
 * that tree is the ABANDONED store: a check pointed at it can only ever describe
 * rows nothing reads, and — once the last model file is deleted — it passes
 * against an empty set however wrong the cascade has become. A check pointed at
 * a store nothing reads passes forever.
 *
 * The replacement enumerates with **drizzle's own reflection** rather than a
 * second regex: `is(value, PgTable)` over the schema barrel, `getTableName`,
 * `getTableColumns`. That reads the OBJECT that generates both the migrations
 * and the queries, so it cannot desync from a parse. It also needs no database —
 * `db/schema/index.ts` imports no connection — so this stays a pure unit test.
 *
 * ## WHY IT KEYS ON ID SHAPE AND NOT ON A LIST OF KNOWN NAMES
 *
 * The first version of this matched a hand-written set of names (`postId`,
 * `oxyUserId`, `authorId`, …). Run against the tree it missed
 * `ModerationEnforcement.subjectId` — a real reference to a post, under a name
 * nobody would have thought to list — and `Trending.actorIds`. A name list can
 * only find references somebody already knew about, which is precisely the class
 * of bug this test exists to prevent. Matching the SHAPE (`…Id`, `…Ids`, `…Uri`,
 * and a few explicit extras) over-collects instead, and every over-collection is
 * dismissed once, in writing, in `NOT_A_CHANNEL_REFERENCE`.
 *
 * The shape regex survived the port UNCHANGED, and that is not luck: `column.name`
 * on a drizzle column is the camelCase PROPERTY name, never the snake_case SQL
 * name — casing is applied at runtime by `drizzle()` (`@oxyhq/db`), not in the
 * table definitions. So the same `Id$`/`Ids$`/`Uri$` shapes the Mongoose schema
 * paths had are the shapes the drizzle columns have. A regex written against
 * `post_id` would have matched NOTHING and passed vacuously, which is the trap
 * CONVENTIONS.md documents.
 */

/**
 * Which column names could carry a reference to an account or a post.
 * `Of$` catches `boostOf`/`quoteOf`; the named extras are the reference columns
 * that carry no id-ish suffix at all.
 */
const ID_SHAPED = /Id$|Ids$|Uri$|Uris$|Of$|Authors$|^createdBy$|^reporter$|^mentions$|^edges$/;

/** Every `pgTable` exported from the barrel, by SQL table name. */
function schemaTables(): Array<{ name: string; columns: string[] }> {
  const tables: Array<{ name: string; columns: string[] }> = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    tables.push({ name: getTableName(value), columns: Object.keys(getTableColumns(value)).sort() });
  }
  return tables.sort((left, right) => left.name.localeCompare(right.name));
}

/** Every `table.column` key in the schema, optionally narrowed to id-shaped ones. */
function declaredKeys(onlyIdShaped: boolean): string[] {
  const keys: string[] = [];
  for (const table of schemaTables()) {
    for (const column of table.columns) {
      if (onlyIdShaped && !ID_SHAPED.test(column)) continue;
      keys.push(`${table.name}.${column}`);
    }
  }
  return keys;
}

const cascadeKeys = new Set(CHANNEL_CASCADE.map((step) => `${step.table}.${step.column}`));
const declared = declaredKeys(true);
/**
 * The staleness check below runs against EVERY declared column, not just the
 * id-shaped ones, because the cascade legitimately covers a few references whose
 * names carry no id suffix (`user_settings.privacyRestrictedUsers`). Narrowing
 * both directions to the same regex would report those as stale.
 */
const allDeclared = new Set(declaredKeys(false));
const tables = schemaTables();

describe('channel deletion cascade covers the real Postgres schema', () => {
  it('scans a plausible number of tables and reference columns', () => {
    // The vacuity floor. A traversal that silently found nothing — a moved
    // barrel, a reflection predicate that stopped matching — would make every
    // assertion below pass by checking nothing, which is the exact failure this
    // file exists to prevent elsewhere.
    //
    // Measured on this tree: 88 tables, 978 columns, 177 id-shaped. The floors
    // sit a little below each, so ordinary growth does not need a test edit
    // while a collapsed traversal still fails.
    expect(tables.length).toBeGreaterThanOrEqual(80);
    expect(allDeclared.size).toBeGreaterThanOrEqual(900);
    expect(declared.length).toBeGreaterThanOrEqual(165);
    expect(cascadeKeys.size).toBeGreaterThanOrEqual(60);
  });

  it('classifies every id-shaped column in every table', () => {
    const unclassified = declared.filter(
      (key) => !cascadeKeys.has(key) && !NOT_A_CHANNEL_REFERENCE.has(key),
    );

    expect(
      unclassified,
      'These schema columns are not covered by the channel-deletion cascade:\n  ' +
        `${unclassified.join('\n  ')}\n` +
        'Every id-shaped column must be classified exactly once. Either add a step to CHANNEL_CASCADE ' +
        '(it references a channel account or a channel post, and here is what happens to it — including ' +
        "action 'database' when a foreign key already does it), or add it to NOT_A_CHANNEL_REFERENCE with " +
        'what the id actually names. Leaving it out means a row pointing at a deleted channel survives, ' +
        'silently.',
    ).toEqual([]);
  });

  it('never classifies one column both ways', () => {
    const both = declared.filter(
      (key) => cascadeKeys.has(key) && NOT_A_CHANNEL_REFERENCE.has(key),
    );

    expect(
      both,
      `These columns are in BOTH CHANNEL_CASCADE and NOT_A_CHANNEL_REFERENCE:\n  ${both.join('\n  ')}\n` +
        'A column is either a reference the cascade handles or not a reference at all. Two answers means ' +
        'the cascade acts on something the manifest also claims is irrelevant.',
    ).toEqual([]);
  });

  it('keeps the manifest from naming columns that no longer exist', () => {
    // The other direction, so the manifest can only ever describe the real
    // schema. Without this a renamed column leaves a cascade step that quietly
    // matches nothing, and the coverage assertion above still passes.
    const stale = [...cascadeKeys, ...NOT_A_CHANNEL_REFERENCE.keys()]
      .filter((key) => !allDeclared.has(key))
      .sort();

    expect(
      stale,
      `The manifest names columns the schema does not declare:\n  ${stale.join('\n  ')}\n` +
        'The column was renamed or removed. Update the manifest — a step that matches nothing is a cascade ' +
        'that has stopped running while still reading as covered.',
    ).toEqual([]);
  });

  it('writes down the references this scanner structurally cannot see', () => {
    // The blind spot, stated rather than hidden. This test reads DECLARED
    // columns, so a reference embedded in a string (`author|<oxyUserId>` inside
    // a feed descriptor) or buried in a `jsonb` blob (an actor uri inside a
    // queued ActivityStreams document) is invisible to it — no column names
    // either.
    //
    // A gate whose limits are undocumented gets mistaken for a complete one.
    // These are enumerated by hand instead, each saying whether the cascade
    // reaches it and, when it does not, why that is harmless.
    expect(EMBEDDED_CHANNEL_REFERENCES.size).toBeGreaterThanOrEqual(5);
    for (const [reference, disposition] of EMBEDDED_CHANNEL_REFERENCES) {
      expect(
        /REACHED|SCRUBBED|NOT REACHED/.test(disposition),
        `${reference} must say whether the cascade reaches it — "probably fine" is how a real orphan gets shipped`,
      ).toBe(true);
    }
  });

  it('states what Oxy owns rather than leaving it out', () => {
    // A reference Mention cannot delete is still a reference. The rule the user
    // set is "nothing orphaned", and an orphan on the far side of the Oxy
    // boundary is still an orphan — it just needs a different operator to close
    // it. Silence here would read as "there is nothing else", which is false.
    expect(OWNED_BY_OXY.size).toBeGreaterThanOrEqual(4);
    for (const [boundary, reason] of OWNED_BY_OXY) {
      expect(boundary.length, 'every cross-boundary entry needs a name').toBeGreaterThan(0);
      expect(
        reason.length,
        `${boundary} needs a written reason — an unexplained exemption is how a real gap gets normalised`,
      ).toBeGreaterThan(40);
    }
  });

  it('gives every cascade step a written reason', () => {
    const unexplained = CHANNEL_CASCADE.filter((step) => step.why.trim().length < 20).map(
      (step) => `${step.table}.${step.column}`,
    );

    expect(
      unexplained,
      `These cascade steps have no real justification:\n  ${unexplained.join('\n  ')}\n` +
        'Deleting a row and scrubbing an entry are different decisions about somebody else\'s data. ' +
        'The reason is what lets the next person tell a deliberate choice from a copy-paste.',
    ).toEqual([]);
  });

  it('deletes rows that exist only for the channel, and scrubs rows that do not', () => {
    // The distinction the whole design rests on: a row that exists BECAUSE of the
    // channel dies with it; a row that belongs to somebody else keeps its
    // content and loses only the pointer. Getting this backwards either strands
    // an orphan or destroys a third party's post.
    //
    // The port changed the OPERATION and not the policy: an array of member ids
    // is a junction table now, so removing one entry is a row delete rather than
    // a `$pull`, and `delete-entry` is the action that says the parent row
    // survives.
    const scrubbed = CHANNEL_CASCADE.filter(
      (step) =>
        step.action === 'delete-entry' ||
        step.action === 'pull-from-array' ||
        step.action === 'unset-field',
    );
    expect(scrubbed.length).toBeGreaterThanOrEqual(10);
  });

  it('leaves the boost/quote decision to the foreign keys that make it', () => {
    // These two are the contested pair, and Postgres now settles them: a boost
    // dies with its original (`ON DELETE CASCADE`), a quote survives with its
    // pointer cleared (`ON DELETE SET NULL`). The manifest must say `database`
    // for both — an explicit leg here would re-run work the DELETE already did
    // and could never be shown to have run, since the rows are gone either way
    // by the time anything checks.
    const quoteStep = CHANNEL_CASCADE.find(
      (step) => step.table === 'posts' && step.column === 'quoteOf',
    );
    expect(
      quoteStep?.action,
      'A quote of a destroyed post keeps its author\'s words. `posts.quote_of` is ON DELETE SET NULL, so ' +
        'the pointer is cleared by the database and the cascade must not add a leg for it.',
    ).toBe('database');
    expect(quoteStep?.why).toMatch(/SET NULL/);

    const boostStep = CHANNEL_CASCADE.find(
      (step) => step.table === 'posts' && step.column === 'boostOf',
    );
    expect(
      boostStep?.action,
      'A boost has an intentionally empty body and renders entirely from its original, so a surviving one ' +
        'is a placeholder card with nothing behind it. `posts.boost_of` is a SELF ON DELETE CASCADE.',
    ).toBe('database');
    expect(boostStep?.why).toMatch(/CASCADE/);
  });

  it('never reattributes a channel post to the person who wrote it', () => {
    // The one rule that is not about referential integrity at all, and the one
    // the database does NOT hold up: `posts.written_by_oxy_user_id` is a plain
    // `text()` Oxy account id with no constraint, so nothing in the schema would
    // stop a reattributing UPDATE. With `signPosts` off, handing the post to its
    // writer would retroactively publish who wrote what — the single promise a
    // channel makes, broken at the moment the channel is no longer there to
    // answer for it.
    const writerStep = CHANNEL_CASCADE.find(
      (step) => step.table === 'posts' && step.column === 'writtenByOxyUserId',
    );

    expect(writerStep, 'writtenByOxyUserId must be classified, not ignored').toBeDefined();
    expect(
      writerStep?.action,
      'The post is destroyed, never handed to its writer.',
    ).toBe('delete-row');
  });

  it('states a mechanism for every step the database performs', () => {
    // `database` is the one action with no leg behind it, so it is the one a
    // reader cannot verify by finding the query. Each entry therefore has to
    // name the constraint that does the work — without that, `database` is
    // indistinguishable from "nobody handles this", which is precisely the
    // silence this manifest exists to remove.
    const unmechanised = CHANNEL_CASCADE.filter(
      (step) => step.action === 'database' && !/CASCADE|SET NULL/.test(step.why),
    ).map((step) => `${step.table}.${step.column}`);

    expect(
      unmechanised,
      `These steps claim the database handles them without saying how:\n  ${unmechanised.join('\n  ')}\n` +
        'Name the constraint (ON DELETE CASCADE / ON DELETE SET NULL) and what it hangs off, so the claim ' +
        'can be checked against the schema rather than believed.',
    ).toEqual([]);
  });
});
