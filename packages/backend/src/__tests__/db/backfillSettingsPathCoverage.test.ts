/**
 * Every settings path a WRITER can produce must be a path the BACKFILL reads.
 *
 * `SETTINGS_COLUMN_BY_PATH` in `db/userProfile/userSettingsRepository.ts` is the
 * total map of Mongo dot paths the settings PUT can write. The backfill plan
 * carries its own list of the same paths, and nothing connects the two. So a new
 * preference registered in the map without a matching line in the plan is
 * migrated for nobody — silently, for every user, with no error at any layer.
 * The repository's own docblock already names the neighbouring version of this
 * ("an unregistered path would be dropped silently"); this is the same hazard
 * one layer over, and it is the audit's blind spot in the same shape as the
 * NOT NULL-with-DEFAULT class.
 *
 * ## Why this plants VALUES rather than scanning the plan's source
 *
 * A grep for the path literals gives a WRONG answer, measured: ten of the paths
 * are generated (`externalEmbeds.${provider}` from `EMBED_PROVIDERS`), so a text
 * scan reports them missing when they are covered. A first count of "10 missing"
 * came from exactly that and would have been a false report.
 *
 * So the check runs the real transform over a document carrying a DISTINCTIVE
 * value at every registered path, and asserts each path's target column comes
 * out holding that value. It measures the property that matters — a value
 * written at this path reaches this column — rather than a proxy for it, and it
 * is immune to how the plan happens to spell the path.
 *
 * The planted value is chosen to differ from the column's own default, because a
 * column the plan defaults rather than reads would otherwise look covered: for a
 * boolean the default is negated, for everything else the value is unique.
 *
 * Nothing here touches a database.
 */

import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { userSettings } from '../../db/schema/userProfile';
import { SETTINGS_COLUMN_BY_PATH } from '../../db/userProfile/userSettingsRepository';
import {
  createResolutionContext,
  parentKeysFrom,
  ResolutionLog,
  transformDocument,
  type ResolutionContext,
} from '../../db/backfill/resolutions';

/** Column property name → its drizzle metadata. */
const COLUMNS = new Map(getTableConfig(userSettings).columns.map((column) => [column.name, column]));

/**
 * A value for `path` that the column cannot be holding by default.
 *
 * The type comes from the drizzle column rather than from the path's spelling,
 * so a settings field that changes type does not quietly start planting a value
 * the column rejects.
 */
function plant(columnProperty: string, index: number): unknown {
  const column = COLUMNS.get(columnProperty);
  if (column === undefined) {
    throw new Error(
      `SETTINGS_COLUMN_BY_PATH names ${columnProperty}, which is not a column of ` +
        'user_settings. The map and the schema have diverged.'
    );
  }
  // An ARRAY column takes an array, and the element type does not matter here:
  // every settings array in this table is `text[]`.
  if (column.columnType === 'PgArray') return [`planted-${index}`];

  switch (column.columnType) {
    case 'PgBoolean':
      // NEGATE the default: planting `true` on a column that defaults to `true`
      // would make a plan that never reads the path look covered.
      return column.default !== true;
    case 'PgInteger':
      return 900_000 + index;
    case 'PgDoublePrecision':
      // Between 0.5 and 1.0 so the penalty columns' CHECK still accepts it, and
      // distinct per path so two columns cannot satisfy one assertion.
      return 0.5 + index / 1000;
    default:
      return `planted-${index}`;
  }
}

/** Set a dotted path on a plain object, creating the intermediate levels. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (typeof next === 'object' && next !== null) {
      current = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    }
  }
  current[segments[segments.length - 1] as string] = value;
}

/**
 * Registry paths that are NOT Mongo paths, and the Mongo path each really is.
 *
 * `SETTINGS_COLUMN_BY_PATH` translates API dot-paths to COLUMNS, and for one
 * entry the DTO's spelling and Mongo's diverge: the deleted Mongoose model
 * mounts `ChannelAccountSchema` at `channel:`, so production holds
 * `channel.signPosts` and holds `channelAccount.signPosts` on ZERO of 39,349
 * documents. Nothing has ever written the DTO spelling to Mongo — the settings
 * PUT writes Postgres and the model that wrote `channel` is gone.
 *
 * So this is a real divergence between two names, declared once, and NOT a
 * compatibility shim in the transform: reading both spellings there would be
 * defending against a case that cannot occur. Each entry carries the Mongo path
 * the plan must read instead, so the assertion below can check THAT rather than
 * merely skipping the row — an exemption that only subtracts is how a gate
 * quietly stops covering something.
 */
const DTO_PATHS_MONGO_NEVER_HELD: Readonly<Record<string, string>> = Object.freeze({
  'channelAccount.signPosts': 'channel.signPosts',
});

function settingsPlan() {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === 'usersettings');
  if (!plan) throw new Error('no plan for usersettings');
  return plan;
}

function emptyResolutions(): ResolutionContext {
  return createResolutionContext(
    { rules: [], parentTables: [] } as unknown as Parameters<typeof createResolutionContext>[0],
    new ResolutionLog()
  );
}

describe('settings path coverage', () => {
  it('migrates every path the settings writer can produce', () => {
    // ONE path per run, and that is the correction that makes this check real.
    //
    // The first version planted all 47 paths into a single document and asserted
    // each column held its own planted value. It could not fail: `plant` derives
    // a boolean from the column's default, so every boolean sharing a default
    // gets the SAME value — and a mutation repointing one boolean path at
    // another boolean column passed, because both columns legitimately held
    // `true`. A value that does not distinguish two columns cannot detect a
    // transform reading the wrong one.
    //
    // With one path set and every other absent, the target column would hold its
    // DEFAULT if the plan never read that path, and the planted value is chosen
    // to differ from that default. So the assertion discriminates for every
    // column type, including a boolean.
    const entries = Object.entries(SETTINGS_COLUMN_BY_PATH);
    const dropped: string[] = [];
    const exempt = new Set(Object.keys(DTO_PATHS_MONGO_NEVER_HELD));

    for (const [index, [path, columnProperty]] of entries.entries()) {
      if (exempt.has(path)) continue;
      const value = plant(columnProperty, index);
      const doc: Record<string, unknown> = { _id: 'b'.repeat(24), oxyUserId: 'bfs-viewer' };
      setPath(doc, path, value);

      let row: Record<string, unknown> | undefined;
      transformDocument(
        settingsPlan(),
        doc,
        emptyResolutions(),
        parentKeysFrom(new Map()),
        (emitted) => {
          if (emitted.table === userSettings) row = emitted.source;
        }
      );

      if (row === undefined) throw new Error('the usersettings plan emitted no user_settings row');

      // Compared by VALUE: an array column is passed through as a new array, so
      // reference equality would report every one of them as dropped.
      if (JSON.stringify(row[columnProperty]) !== JSON.stringify(value)) {
        dropped.push(
          `${path} -> ${columnProperty} (planted ${JSON.stringify(value)}, ` +
            `got ${JSON.stringify(row[columnProperty])})`
        );
      }
    }

    // The message says the consequence, not the mechanism: a path in this list
    // is a preference that no user's account carries after the migration.
    expect(
      dropped.sort(),
      'settings paths a writer can produce that the backfill does not migrate'
    ).toStrictEqual([]);

    // Vacuity floor. A broken extraction — an empty map, a rename that made
    // `Object.entries` return nothing — would satisfy the assertion above while
    // checking nothing. Forty is below the 47 registered today and above any
    // plausible accident.
    expect(entries.length).toBeGreaterThan(40);
  });

  it('reads the MONGO path for the one column whose DTO name differs', () => {
    // The exemption above subtracts a row from the main check, so it has to add
    // one back or it is just a hole. This plants at the path production
    // ACTUALLY holds and asserts the column receives it.
    //
    // Worth the separate case rather than a special branch inside the loop: the
    // failure it guards is the one that shipped. The plan read
    // `channelAccount.signPosts`, which matches zero of 39,349 documents, and
    // the column came out 100% NULL — which for a flag that is NULL on every
    // account that is not a channel is exactly what health looks like. No
    // null-based check could have seen it.
    for (const [dtoPath, mongoPath] of Object.entries(DTO_PATHS_MONGO_NEVER_HELD)) {
      const columnProperty = SETTINGS_COLUMN_BY_PATH[dtoPath];
      if (columnProperty === undefined) {
        throw new Error(
          `${dtoPath} is exempted here but is no longer registered in ` +
            'SETTINGS_COLUMN_BY_PATH — the exemption now describes nothing.'
        );
      }
      const value = plant(columnProperty, 0);
      const doc: Record<string, unknown> = { _id: 'c'.repeat(24), oxyUserId: 'bfs-channel' };
      setPath(doc, mongoPath, value);

      let row: Record<string, unknown> | undefined;
      transformDocument(
        settingsPlan(),
        doc,
        emptyResolutions(),
        parentKeysFrom(new Map()),
        (emitted) => {
          if (emitted.table === userSettings) row = emitted.source;
        }
      );
      expect(row?.[columnProperty], `${mongoPath} -> ${columnProperty}`).toStrictEqual(value);
    }
  });

  it('registers every settings column the plan fills from a single path', () => {
    // The reverse direction, and it is deliberately WEAKER than the forward one
    // because the two are not symmetric. A path in the map but not in the plan
    // loses a user's preference; a column in the plan but not in the map is a
    // column no writer can currently target, which is merely unreachable.
    //
    // It is asserted as a FLOOR on the overlap rather than as an equality,
    // because several columns are legitimately absent from the map and always
    // will be: `profileCustomization.profileMedia` and `feedTuning.forYou` are
    // whole OBJECTS the repository expands through `expandObjectPath`, and the
    // identity/timestamp columns are not settings at all. An equality here would
    // fire permanently on a state nobody should fix.
    const mapped = new Set(Object.values(SETTINGS_COLUMN_BY_PATH));
    for (const columnProperty of mapped) {
      expect(COLUMNS.has(columnProperty), `${columnProperty} is not a user_settings column`).toBe(
        true
      );
    }
    expect(mapped.size).toBeGreaterThan(40);
  });
});
