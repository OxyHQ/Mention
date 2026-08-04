import { appendFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type { MediaItem } from '@mention/shared-types';

import * as schema from '../../db/schema';
import { MEDIA_ORIENTATIONS, MEDIA_TYPES } from '../../db/schema/postContent';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import {
  assertHistoryIsAvailable,
  deletedModelSources,
  loadDeletedModels,
} from '../helpers/deletedModelSources';
import { allowedValues } from '../../db/backfill/plan';

/**
 * EVERY CLOSED VALUE SET IN THE SCHEMA MATCHES THE VOCABULARY ITS SOURCE USES.
 *
 * ## The failure this exists to make impossible
 *
 * `schema/blocklist.ts` once declared
 * `BLOCKLIST_SOURCE_OUTCOMES = ['published','unavailable','unparseable','empty']`
 * and migration `0008` put it in a CHECK on
 * `blocklist_proposal_run_sources.outcome`. The real vocabulary — the one the
 * poller emits and the Mongoose model derives from with `satisfies` — is
 * `'published' | 'not-published' | 'failed'`. **Zero overlap past `published`,**
 * and `backfill/plans/blocklist.ts` copies `outcome` verbatim, so the CHECK
 * would have refused every production row.
 *
 * Nothing caught it because the schema, the CHECK, the plan and the tests all
 * agreed with each other and none of them had an external referent: the
 * fixtures were written from the invented list. **Four artefacts agreeing is not
 * evidence.** The only thing that breaks that loop is real data, and real data
 * arrives during the backfill — the cutover window, the worst possible moment.
 * This file moves the comparison to CI by giving each set an external referent
 * and reading it.
 *
 * ## What counts as a closed set, and why the walk is not a name list
 *
 * A closed set is any column carrying `enumValues` — directly, or on its
 * `baseColumn` when the column is an array of them. They are found by walking
 * the schema BARREL, never by naming files: a `src/models/` literal has already
 * produced three separate blind spots in this migration (a short model
 * inventory, a short TTL enumeration, and a test asserting an exact count that
 * agreed with the blind spot). {@link SEMANTIC_FLOOR} is the vacuity floor and
 * it is deliberately not a count — a count floor cannot see a broken parse,
 * whereas "`posts.status` resolves to exactly these four members on the
 * Postgres side and exactly these three on the Mongoose side" can only pass if
 * the walk really parsed both sides.
 *
 * ## The source is DERIVED, not restated
 *
 * The Mongo path for each column already exists: `EnumAudit` declares it in the
 * collection plans, because the pre-flight audit needs the same mapping to
 * `distinct()` the live collection. This file reads those declarations and
 * resolves the path against the model registry, so the mapping has exactly one
 * home. A hand-copied list is what went wrong in the first place.
 *
 * ## Once the port deletes a model, GIT becomes the source of truth
 *
 * Production runs `main`, where every model still exists; this branch deletes
 * each one as its collection is ported. So a check that reads only the working
 * tree loses coverage **as the work succeeds** — silently, one model at a time,
 * reporting green the whole way down. That shape has already cost this
 * migration once, in `expiry.test.ts`, where finishing a port made a gate read
 * as a regression.
 *
 * `deletedModelSources.ts` therefore recovers the deleted files from history
 * and imports them, so the comparison simply keeps running. A hand-maintained
 * list of "collections whose model is gone, verified at the time" was written
 * first and removed: an entry records that somebody once checked, which is not
 * a check, and it goes stale the moment the vocabulary it exempts is edited.
 *
 * This makes the test need real git history. A shallow clone finds no deletions
 * and would report none — indistinguishable from a port that has deleted none —
 * so `assertHistoryIsAvailable` refuses instead. CI must check out with
 * `fetch-depth: 0` for the job that runs it.
 *
 * ## This file has planned obsolescence, and prints its own coverage
 *
 * Everything it compares depends on a Mongoose model existing somewhere. When
 * Mongo is switched off and the collection plans are deleted, there is nothing
 * left to compare and this file should be deleted with them — the state to fear
 * is the one just before that, a test protecting nothing and reading as green.
 * So the coverage numbers are PRINTED on every run rather than described in a
 * comment. See the `reports how much it still covers` case for the full
 * argument, including why the git-history path stops that decay being a
 * schedule.
 *
 * The pre-flight `EnumAudit` in `backfill/audit.ts` is what inherits the
 * guarantee — it reads the accepted set off the drizzle column and `distinct()`s
 * the real collection before a single row is inserted. It is a genuine external
 * referent that only speaks during the cutover, which is the whole reason this
 * file exists beside it rather than instead of it. Anything printed as EXEMPT
 * here is something production, not CI, has to answer for.
 */

/** A closed set found on a column, keyed the way a failure message names it. */
interface ClosedSet {
  readonly key: string;
  readonly table: string;
  readonly column: string;
  readonly values: readonly string[];
}

/** Walk the barrel — every table, every column that carries a closed set. */
function closedSetsInSchema(): ClosedSet[] {
  const found: ClosedSet[] = [];
  for (const exported of Object.values(schema)) {
    if (!is(exported, PgTable)) continue;
    const config = getTableConfig(exported as PgTable);
    for (const column of config.columns) {
      const direct = (column as unknown as { enumValues?: readonly string[] }).enumValues;
      const base = (column as unknown as { baseColumn?: { enumValues?: readonly string[] } })
        .baseColumn?.enumValues;
      const values = direct?.length ? direct : base;
      if (!values?.length) continue;
      found.push({
        key: `${config.name}.${column.name}`,
        table: config.name,
        column: column.name,
        values,
      });
    }
  }
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

/** Where a column's values come from in Mongo, as the collection plans declare it. */
interface DeclaredSource {
  readonly collection: string;
  readonly path: string;
}

function declaredSources(): Map<string, DeclaredSource> {
  const sources = new Map<string, DeclaredSource>();
  for (const plan of COLLECTION_PLANS) {
    for (const audit of plan.enumAudits ?? []) {
      const table = getTableConfig((audit.column as unknown as { table: PgTable }).table).name;
      sources.set(`${table}.${audit.column.name}`, {
        collection: plan.collection,
        path: audit.path,
      });
    }
  }
  return sources;
}

/**
 * Every `enum:` any registered Mongoose model declares, keyed
 * `<collection>:<dotted path>`.
 *
 * Sub-schemas are walked rather than looked up, because `schema.path()` does not
 * reach into an array of subdocuments, and half of these vocabularies live there
 * (`content.attachments.type`, `authorship.role`, `sources.outcome`). An array
 * of scalars keeps its enum on the CASTER, and both spellings key the same way:
 * `distinct()` on either path returns the elements, which is the set the CHECK
 * constrains.
 */
async function mongooseVocabularies(): Promise<{
  vocabularies: Map<string, readonly (string | number)[]>;
  /** Collections that only exist in history — reported, never hidden. */
  fromHistory: Map<string, string>;
  unloadable: { repoPath: string; reason: string }[];
}> {
  // A WALK, not a name list. `src/models/` is the only directory a model file
  // has ever lived in for these collections, but the reason to walk is that a
  // model added tomorrow must be compared without anyone remembering to add it
  // here — the short-inventory blind spot this migration has hit three times.
  const modelsDir = path.resolve(__dirname, '../../models');
  for (const file of readdirSync(modelsDir).filter((name) => name.endsWith('.ts'))) {
    await import(/* @vite-ignore */ pathToFileURL(path.join(modelsDir, file)).href);
  }
  const live = new Set(
    mongoose.modelNames().map((name) => mongoose.model(name).collection.collectionName)
  );

  // THEN history — after the live models, so a name that still exists wins and
  // the historical file's `mongoose.model()` throws `OverwriteModelError` into
  // `unloadable` rather than shadowing the truth.
  const repoRoot = path.resolve(__dirname, '../../../../..');
  assertHistoryIsAvailable(repoRoot);
  const unloadable = await loadDeletedModels(
    deletedModelSources(repoRoot, 'packages/backend/src/models'),
    path.resolve(__dirname, `../../__deleted_model_sources_${process.pid}__`)
  );

  const fromHistory = new Map<string, string>();
  const vocabularies = new Map<string, readonly (string | number)[]>();
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    const collection = model.collection.collectionName;
    if (!live.has(collection)) fromHistory.set(collection, name);
    const walk = (subject: mongoose.Schema, prefix: string) => {
      subject.eachPath((property, type) => {
        const dotted = prefix ? `${prefix}.${property}` : property;
        const inspected = type as unknown as {
          enumValues?: (string | number)[];
          caster?: { enumValues?: (string | number)[]; options?: { enum?: unknown } };
          options?: { enum?: unknown };
          schema?: mongoose.Schema;
        };
        // `enumValues` is a SchemaString property. A NUMERIC enum
        // (`{ type: Number, enum: [1, -1] }`) leaves it undefined and keeps the
        // set on `options.enum` only — measured, not assumed, and it is why
        // `likes.value` was invisible to the first version of this walk.
        const numeric = [inspected.options?.enum, inspected.caster?.options?.enum].find(
          (candidate): candidate is (string | number)[] => Array.isArray(candidate)
        );
        const values = inspected.enumValues?.length
          ? inspected.enumValues
          : (inspected.caster?.enumValues ?? numeric);
        if (values?.length) vocabularies.set(`${collection}:${dotted}`, values);
        if (inspected.schema) walk(inspected.schema, dotted);
      });
    };
    walk(model.schema, '');
  }
  return { vocabularies, fromHistory, unloadable };
}

/**
 * Sets Postgres declares WIDER than Mongo, on purpose.
 *
 * A widening is safe under a verbatim copy — every production value still
 * satisfies the CHECK — but it is never safe to assume, so each is named with
 * what added the value. Anything else about these two columns, a NARROWING
 * above all, is still reported.
 */
const WIDENED_ON_PURPOSE: Readonly<Record<string, { added: readonly string[]; why: string }>> = {
  'posts.status': {
    added: ['restricted'],
    why: "CrowdSource enforcement's `restrict` action. `PostPublicationStatus` in shared-types carries the fourth value; `CreatePostRequest` deliberately does not, so a client cannot ask for it.",
  },
  'post_attachments.type': {
    added: ['room'],
    why: '`@mention/shared-types` `PostAttachmentType` declares eight; the Mongoose `AttachmentSchema` omits `room`. The narrower list is the one that was never enforced (`runValidators` is set nowhere in this package), so the CHECK takes the union.',
  },
};

/**
 * Columns whose vocabulary Mongo never expressed as an `enum:`.
 *
 * Each names the TypeScript type that IS the vocabulary. The four media columns
 * are additionally pinned to that type at COMPILE time below, which is a
 * stronger referent than this list — the entry exists so the walk still
 * classifies them rather than skipping them silently.
 */
const NO_MONGOOSE_ENUM: Readonly<Record<string, string>> = {
  'post_media.type': '`MediaItem.type` in @mention/shared-types; Mongo enforced it in a hand-written validator (models/Post.ts), never an `enum:`.',
  'post_media.orientation': '`MediaItem.orientation` in @mention/shared-types; same hand-written validator.',
  'post_variant_media.type': '`MediaItem.type` — the same subdocument one level down, inside `content.variants`.',
  'post_variant_media.orientation': '`MediaItem.orientation` — same.',
};

/**
 * Collections whose Mongoose vocabulary is UNRECOVERABLE — and where the
 * guarantee went instead.
 *
 * ## Why a recovered file can stop loading
 *
 * The history path imports the deleted model out of the commit that removed it,
 * but **a module recovered from git is not hermetic: its own imports resolve
 * against TODAY's tree.** So a deletion that also drops a shared constant the
 * historical model consumed makes that model unevaluatable, and the vocabulary
 * dies with it. Concretely, historical `models/Lane.ts` is:
 *
 *     import { LANE_DISPLAY_MODES, LANE_OWNER_TYPES } from '@mention/shared-types';
 *     …
 *     enum: [...LANE_OWNER_TYPES],     // line 60 — `undefined` since the redesign
 *     enum: [...LANE_DISPLAY_MODES],   // line 68 — never reached
 *
 * `LANE_OWNER_TYPES` went with the polymorphic lane owner, so the spread throws
 * `not iterable` and the module dies EIGHT LINES before the enum this file
 * needs. Nothing is wrong with the path or the plan; the referent is simply
 * gone.
 *
 * ## Why this is a handoff and not a hole
 *
 * The obvious repair — compare the column against the Postgres constant it was
 * declared from — is a TAUTOLOGY: `schema/channels.ts` builds both the column
 * and its CHECK from `LANE_DISPLAY_MODES`, so the comparison is that constant
 * against itself and cannot fail for any value, ever. That is precisely the
 * "four artefacts agreeing is not evidence" loop this file was written to
 * break, so it is not done.
 *
 * What actually inherits the guarantee is the pre-flight **`EnumAudit` in
 * `backfill/audit.ts`**, which reads the accepted set off the drizzle column and
 * `distinct()`s the REAL collection before a row is copied. An entry here is
 * therefore a statement about WHERE the check moved — not that it stopped.
 *
 * Three properties keep this from rotting into an ordinary exemption: it is
 * keyed by COLLECTION with a written reason, the count is PRINTED in the
 * coverage summary so the loss stays visible, and
 * `names no exemption that has stopped being one` fails if a listed collection's
 * model ever loads again.
 */
const HISTORY_UNRECOVERABLE: Readonly<Record<string, string>> = {
  lanes:
    'historical `models/Lane.ts` spreads `LANE_OWNER_TYPES`, which the channels redesign ' +
    'removed from @mention/shared-types, so the module throws before declaring ' +
    '`displayMode`. Its vocabulary is now production\'s to answer for, via `EnumAudit` at ' +
    'cutover.',
  // `topics` is deliberately NOT here. Historical `models/Topic.ts` also fails to
  // evaluate, but no collection plan reads that collection, so nothing needed its
  // vocabulary — a retired model, which the load case already tolerates. Listing
  // it was the first thing the staleness check below rejected, on its first run.
};

/**
 * The name the numeric comparison already used for this idea.
 *
 * It was referenced at exactly one call site and DEFINED NOWHERE — a
 * `ReferenceError` waiting in a branch that only runs when a numeric path fails
 * to resolve, which no set has yet done. `tsconfig.json` excludes `src/__tests__`,
 * so no typecheck has ever looked at this file; a `TS2304` would have named it
 * the moment it was written.
 */
const MONGOOSE_MODEL_DELETED_BY_THE_PORT = HISTORY_UNRECOVERABLE;

/** Sets that exist only in Postgres, with what made them necessary. */
const POSTGRES_ONLY: Readonly<Record<string, string>> = {
  'custom_feed_definition_modules.kind':
    'Mongo held three parallel arrays (`sources`/`signals`/`filters`); one table with a discriminator replaces them, so the discriminator has no Mongo counterpart to match.',
};

/**
 * The vacuity floor — SEMANTIC, not a count.
 *
 * Each entry asserts what a named set resolves to on BOTH sides. A broken walk,
 * a parser that stops descending into subdocument arrays, or a barrel that
 * stopped exporting a module makes one of these resolve to nothing, and the
 * failure names which. A "more than N sets were found" floor passes happily
 * against all three.
 */
const SEMANTIC_FLOOR: readonly {
  readonly key: string;
  readonly postgres: readonly string[];
  readonly mongoose: readonly string[];
}[] = [
  // A scalar the port deliberately widened.
  {
    key: 'posts.status',
    postgres: ['draft', 'published', 'scheduled', 'restricted'],
    mongoose: ['draft', 'published', 'scheduled'],
  },
  // Inside an array of SUBDOCUMENTS — only reachable by descending sub-schemas.
  {
    key: 'post_authorships.role',
    postgres: ['owner', 'collaborator'],
    mongoose: ['owner', 'collaborator'],
  },
  // An array of SCALARS — the enum lives on the caster, not on the path.
  {
    key: 'posts.replyPermission',
    postgres: ['anyone', 'followers', 'following', 'mentioned', 'nobody'],
    mongoose: ['anyone', 'followers', 'following', 'mentioned', 'nobody'],
  },
  // A collection whose model declares an explicit `collection:` option, so the
  // collection name cannot be derived from the model name.
  {
    key: 'moderation_outbox.status',
    postgres: ['pending', 'processing', 'processed', 'dead_letter'],
    mongoose: ['pending', 'processing', 'processed', 'dead_letter'],
  },
  // A model this port DELETED. It resolves only through the git-history path, so
  // this entry is what proves that path ran — a silent failure there would make
  // every deleted collection unverified while the file still reported green,
  // which is precisely the coverage-shrinks-as-work-succeeds trap.
  {
    key: 'user_settings.appearanceThemeMode',
    postgres: ['light', 'dark', 'system', 'adaptive'],
    mongoose: ['light', 'dark', 'system', 'adaptive'],
  },
  // The original defect, and the reason this file exists. Also a deleted model,
  // and also inside an array of subdocuments — so it exercises the history path
  // and the sub-schema descent at once.
  {
    key: 'blocklist_proposal_run_sources.outcome',
    postgres: ['published', 'not-published', 'failed'],
    mongoose: ['published', 'not-published', 'failed'],
  },
];

/**
 * COMPILE-TIME pins for the vocabularies Mongo never declared as an `enum:`.
 *
 * `satisfies` alone would only prove the members are assignable — it accepts a
 * set that is missing a value, which is half the defect this file is about. The
 * assignment in both directions is what makes it an equality.
 */
const _mediaTypesMatchTheContract: readonly MediaItem['type'][] = MEDIA_TYPES;
const _mediaTypesCoverTheContract: readonly (typeof MEDIA_TYPES)[number][] = [
  'image',
  'video',
  'gif',
] satisfies readonly MediaItem['type'][];
const _orientationsMatchTheContract: readonly NonNullable<MediaItem['orientation']>[] =
  MEDIA_ORIENTATIONS;
const _orientationsCoverTheContract: readonly (typeof MEDIA_ORIENTATIONS)[number][] = [
  'portrait',
  'landscape',
  'square',
] satisfies readonly NonNullable<MediaItem['orientation']>[];
void _mediaTypesMatchTheContract;
void _mediaTypesCoverTheContract;
void _orientationsMatchTheContract;
void _orientationsCoverTheContract;

const CLOSED_SETS = closedSetsInSchema();
const SOURCES = declaredSources();
// Top-level await: the model registry has to be populated before any `describe`
// body runs, and `it.each` reads it at collection time.
const { vocabularies: VOCABULARIES, fromHistory: FROM_HISTORY, unloadable: UNLOADABLE } =
  await mongooseVocabularies();

/** Resolvable = the plan declares a Mongo path AND that path still has an enum. */
function resolve(set: ClosedSet): readonly (string | number)[] | undefined {
  const source = SOURCES.get(set.key);
  if (!source) return undefined;
  return VOCABULARIES.get(`${source.collection}:${source.path}`);
}

describe('this gate reports how much it still covers', () => {
  /**
   * COVERAGE IS PRINTED, because this file has PLANNED OBSOLESCENCE.
   *
   * Every set it compares depends on a Mongoose model existing somewhere — the
   * working tree or git history. The port is deleting those models, and when
   * Mongo is finally switched off the collection plans go too. At that point
   * there is nothing left to compare and this file should be DELETED alongside
   * them, not left green and empty.
   *
   * The danger is the state just before that: a test that protects nothing and
   * reads as passing, arrived at entirely legitimately. So the numbers go in the
   * OUTPUT rather than in a comment — a human reading a green run sees what the
   * run actually measured, and sees it move.
   *
   * **The git-history path is what stops the decay being a schedule.** With the
   * hand-maintained exemption list this file started with, coverage really would
   * have fallen to zero one deletion at a time. Reading the deleted model out of
   * the commit that removed it keeps the comparison alive, so today's numbers do
   * not drop when `callsites-pg` deletes the next model — they move from `live`
   * to `history`, which is why both are printed separately.
   *
   * What DOES decay, slowly and visibly: a historical model file whose own
   * imports have since been deleted stops loading (`Topic.ts` already has).
   * `could load every deleted model whose collection a plan still reads` turns
   * that into a hard failure the moment it happens to a collection the backfill
   * still copies — so the decay is loud, not silent.
   *
   * **What inherits the guarantee is the pre-flight `EnumAudit`** in
   * `backfill/audit.ts`: it reads the accepted set off the drizzle column and
   * `distinct()`s the real collection before a single row is copied. Anything
   * this file cannot reach is something PRODUCTION, not CI, must answer for —
   * which makes the uncompared list below an input to the cutover checklist
   * rather than an apology.
   */
  it('accounts for every closed set as compared or explicitly exempt', () => {
    const compared = CLOSED_SETS.filter((set) => resolve(set));
    const exempt = CLOSED_SETS.filter((set) => NO_MONGOOSE_ENUM[set.key] || POSTGRES_ONLY[set.key]);
    // Counted apart from `exempt` on purpose: an exemption says a Mongoose enum
    // never existed, this says one existed and can no longer be READ. The two
    // decay differently and collapsing them would hide which is growing.
    const unrecoverable = CLOSED_SETS.filter(
      (set) =>
        !resolve(set) &&
        !NO_MONGOOSE_ENUM[set.key] &&
        !POSTGRES_ONLY[set.key] &&
        HISTORY_UNRECOVERABLE[SOURCES.get(set.key)?.collection ?? '']
    );
    const viaHistory = compared.filter((set) =>
      FROM_HISTORY.has(SOURCES.get(set.key)?.collection ?? '')
    );

    const summary =
      `closed value sets: ${CLOSED_SETS.length} total — ${compared.length} compared ` +
      `(${compared.length - viaHistory.length} live models, ${viaHistory.length} recovered from ` +
      `git history), ${exempt.length} exempt with a named reason, ` +
      `${unrecoverable.length} whose model no longer evaluates.\n` +
      "Exempt, and therefore production's to answer for at cutover:\n" +
      exempt.map((set) => `  - ${set.key}`).join('\n') +
      (unrecoverable.length === 0
        ? ''
        : '\nMongoose vocabulary UNRECOVERABLE — handed off to `EnumAudit` at cutover:\n' +
          unrecoverable
            .map(
              (set) =>
                `  - ${set.key}: ${HISTORY_UNRECOVERABLE[SOURCES.get(set.key)?.collection ?? '']}`
            )
            .join('\n'));

    // `process.stdout.write`, not `console.log`: vitest's DEFAULT reporter — the
    // one CI runs — swallows `console` output from a PASSING file, which is
    // exactly the run this number needs to be visible on. Measured, not assumed:
    // under `--reporter=default` the line never appeared, under `verbose` it did.
    process.stdout.write(`\n${summary}\n\n`);

    // And onto the job summary in CI, the same channel the bundle report already
    // uses, so a green run puts the number in front of a person rather than
    // burying it in a log nobody opens.
    const stepSummary = process.env.GITHUB_STEP_SUMMARY;
    if (stepSummary) {
      appendFileSync(stepSummary, `\n### Closed value sets\n\n${summary}\n`, 'utf8');
    }

    // Not a threshold — thresholds rot in both directions. This says only that
    // nothing fell out of BOTH buckets, so a set can never go uncounted while
    // the printed total keeps looking healthy.
    expect(compared.length + exempt.length + unrecoverable.length).toBe(CLOSED_SETS.length);
  });
});

describe('the walk found the sets it is supposed to find', () => {
  it.each(SEMANTIC_FLOOR)('resolves $key on both sides', ({ key, postgres, mongoose: expected }) => {
    const set = CLOSED_SETS.find((candidate) => candidate.key === key);
    expect(set, `${key} is not among the ${CLOSED_SETS.length} closed sets the walk found`).toBeDefined();
    expect([...(set?.values ?? [])].sort()).toEqual([...postgres].sort());

    const source = SOURCES.get(key);
    expect(source, `${key} has no EnumAudit declaring its Mongo path`).toBeDefined();
    const resolved = VOCABULARIES.get(`${source?.collection}:${source?.path}`);
    expect(
      resolved,
      `${source?.collection}:${source?.path} resolved to nothing — the Mongoose walk did not reach it`
    ).toBeDefined();
    expect([...(resolved ?? [])].sort()).toEqual([...expected].sort());
  });

  it('resolves the numeric sets, including the nullable spelling', () => {
    // `likes.value` is the plain form; `engagement_outbox.payload.value` is
    // nested AND nullable, so it is the one that proves both that the walk
    // descends a `payload` subdocument and that `null` really does arrive in the
    // Mongoose enum — which is what the numeric comparison filters out.
    expect(VOCABULARIES.get('likes:value')).toEqual([1, -1]);
    expect(VOCABULARIES.get('engagement_outbox:payload.value')).toEqual([1, -1, null]);
  });
});

describe('every closed value set matches its Mongoose source', () => {
  it('has no set that disagrees with the vocabulary Mongo holds', () => {
    const mismatches: string[] = [];
    for (const set of CLOSED_SETS) {
      const mongo = resolve(set);
      if (!mongo) continue;

      const declaredWidening = WIDENED_ON_PURPOSE[set.key]?.added ?? [];
      const onlyInPostgres = set.values.filter(
        (value) => !mongo.includes(value) && !declaredWidening.includes(value)
      );
      const onlyInMongoose = mongo.filter((value) => !set.values.includes(String(value)));
      if (onlyInPostgres.length === 0 && onlyInMongoose.length === 0) continue;

      const source = SOURCES.get(set.key);
      mismatches.push(
        `${set.key} (from ${source?.collection}:${source?.path})\n` +
          `  only in Postgres: [${onlyInPostgres.join(', ')}]\n` +
          `  only in Mongoose: [${onlyInMongoose.join(', ')}]`
      );
    }
    expect(mismatches.join('\n\n')).toBe('');
  });

  it('has no NUMERIC closed set that disagrees either', () => {
    // A numeric column carries no `enumValues` — `integer()` has nowhere to put
    // them — so the three closed sets over numbers live on `NumericAudit.values`
    // instead and would be invisible to the walk above. They are the same class
    // of claim and get the same comparison.
    //
    // Mongoose spells a nullable numeric enum `[1, -1, null]`; the `null` is how
    // it permits an absent value, not a member of the vocabulary, and the CHECK
    // says the same thing as `(x is null or x in (1,-1))`. So it is dropped
    // rather than reported as a value Postgres is missing.
    const mismatches: string[] = [];
    for (const plan of COLLECTION_PLANS) {
      for (const audit of plan.numericAudits ?? []) {
        if (!audit.values) continue;
        const table = getTableConfig((audit.column as unknown as { table: PgTable }).table).name;
        const mongo = VOCABULARIES.get(`${plan.collection}:${audit.path}`);
        if (!mongo) {
          if (MONGOOSE_MODEL_DELETED_BY_THE_PORT[plan.collection]) continue;
          mismatches.push(
            `${table}.${audit.column.name} (from ${plan.collection}:${audit.path}) — the path ` +
              'declares no Mongoose enum, so nothing checks this set.'
          );
          continue;
        }
        const members = mongo.filter((value) => value !== null && value !== undefined);
        const onlyInPostgres = audit.values.filter((value) => !members.includes(value));
        const onlyInMongoose = members.filter(
          (value) => !(audit.values as readonly number[]).includes(Number(value))
        );
        if (onlyInPostgres.length === 0 && onlyInMongoose.length === 0) continue;
        mismatches.push(
          `${table}.${audit.column.name} (from ${plan.collection}:${audit.path})\n` +
            `  only in Postgres: [${onlyInPostgres.join(', ')}]\n` +
            `  only in Mongoose: [${onlyInMongoose.join(', ')}]`
        );
      }
    }
    expect(mismatches.join('\n\n')).toBe('');
  });

  it('still applies every declared widening, so a stale exemption cannot hide', () => {
    // A widening that stopped being one is a list entry nobody will remove — and
    // the entry suppresses a real finding on that column for as long as it sits
    // there. Both halves are checked: the column exists, and Mongo really is
    // missing every value the entry claims Postgres added.
    for (const [key, { added }] of Object.entries(WIDENED_ON_PURPOSE)) {
      const set = CLOSED_SETS.find((candidate) => candidate.key === key);
      expect(set, `WIDENED_ON_PURPOSE names ${key}, which is not a closed set`).toBeDefined();
      const mongo = resolve(set as ClosedSet);
      expect(
        mongo,
        `WIDENED_ON_PURPOSE names ${key}, whose Mongoose source did not resolve — a widening ` +
          'that cannot be checked is a claim, not an exemption'
      ).toBeDefined();
      for (const value of added) {
        expect(
          set?.values.includes(value),
          `WIDENED_ON_PURPOSE claims ${key} adds '${value}', but the column does not carry it`
        ).toBe(true);
        expect(
          mongo?.includes(value),
          `WIDENED_ON_PURPOSE claims ${key} adds '${value}', but Mongoose has it too — drop the entry`
        ).toBe(false);
      }
    }
  });
});

describe('every closed value set is classified', () => {
  it('leaves no set without either a Mongoose source or a named reason', () => {
    const unclassified: string[] = [];
    for (const set of CLOSED_SETS) {
      if (resolve(set)) continue;
      if (NO_MONGOOSE_ENUM[set.key] || POSTGRES_ONLY[set.key]) continue;
      // Its model cannot be evaluated at all — see HISTORY_UNRECOVERABLE. The
      // set is classified, by collection rather than by column, because the
      // whole model is what went.
      if (HISTORY_UNRECOVERABLE[SOURCES.get(set.key)?.collection ?? '']) continue;
      const source = SOURCES.get(set.key);
      unclassified.push(
        source
          ? `${set.key} — its plan declares ${source.collection}:${source.path}, and that path ` +
            'has no Mongoose enum in the working tree OR in the history of ' +
            '`packages/backend/src/models`. Either the path is wrong, or the vocabulary was ' +
            'never a Mongoose enum (add it to NO_MONGOOSE_ENUM naming the type that owns it).'
          : `${set.key} — no EnumAudit declares a Mongo path for it, and it is in no exemption list.`
      );
    }
    expect(unclassified.join('\n')).toBe('');
  });

  it('could load every deleted model whose collection a plan still reads', () => {
    // A historical file that will not import is fine for a RETIRED model — `Room`,
    // `Space`, `Analytics` — because nothing plans those. It is not fine for one
    // the backfill still copies: that is coverage lost silently, which is the
    // failure this whole file exists to prevent. So the load errors are kept and
    // filtered by whether anything needed them, rather than logged and dropped.
    const needed = new Set(COLLECTION_PLANS.map((plan) => plan.collection));
    const missing = [...needed].filter(
      (collection) =>
        // Listed in HISTORY_UNRECOVERABLE with a written reason and a named
        // inheritor. Not "ignore this" — the coverage summary prints it, and the
        // staleness case below fails the moment such a model loads again.
        !HISTORY_UNRECOVERABLE[collection] &&
        !FROM_HISTORY.has(collection) &&
        !mongoose.modelNames().some((n) => mongoose.model(n).collection.collectionName === collection) &&
        COLLECTION_PLANS.some((plan) => plan.collection === collection && (plan.enumAudits ?? []).length > 0)
    );
    expect(
      missing.join(', '),
      `these planned collections have closed sets but no model, live or historical. Load errors ` +
        `were:\n${UNLOADABLE.map((entry) => `  ${entry.repoPath}: ${entry.reason}`).join('\n')}`
    ).toBe('');
  });

  it('names no exemption that has stopped being one', () => {
    const stale: string[] = [];
    for (const key of [...Object.keys(NO_MONGOOSE_ENUM), ...Object.keys(POSTGRES_ONLY)]) {
      const set = CLOSED_SETS.find((candidate) => candidate.key === key);
      if (!set) {
        stale.push(`${key} is exempted but is no longer a closed set in the schema.`);
        continue;
      }
      if (resolve(set)) {
        stale.push(`${key} is exempted but now resolves to a Mongoose enum — remove the entry.`);
      }
    }
    // The same discipline for the unrecoverable list, keyed by COLLECTION. This
    // is the property that keeps it from becoming an exemption nobody rechecks:
    // if the model becomes loadable again — a shared constant restored, a
    // historical import repaired — the entry must go, and the comparison must
    // come back rather than staying quietly handed off.
    for (const [collection, reason] of Object.entries(HISTORY_UNRECOVERABLE)) {
      if (!COLLECTION_PLANS.some((plan) => plan.collection === collection)) {
        stale.push(
          `HISTORY_UNRECOVERABLE names '${collection}', which no collection plan reads — ` +
            'delete the entry with the plan.'
        );
        continue;
      }
      if (FROM_HISTORY.has(collection)) {
        stale.push(
          `HISTORY_UNRECOVERABLE claims '${collection}' cannot be recovered (${reason}), but its ` +
            'model loaded from history on this run — remove the entry so the vocabulary is ' +
            'compared again.'
        );
      }
    }
    expect(stale.join('\n')).toBe('');
  });
});

describe('the pre-flight audit can actually read every set', () => {
  it('has an EnumAudit for every closed-set column', () => {
    const unaudited = CLOSED_SETS.filter(
      (set) => !SOURCES.has(set.key) && !POSTGRES_ONLY[set.key]
    ).map((set) => set.key);
    expect(unaudited.join(', ')).toBe('');
  });

  /**
   * EVERY `enumAudits` DECLARATION RESOLVES — statically, no database, no Mongo.
   *
   * This is a WIRING question, not a data question, and it is the one the value
   * comparison above cannot ask. `allowedValues()` THROWS for a column carrying
   * neither `enumValues` nor a `baseColumn` with them; `auditEnums` calls it as
   * the FIRST statement of every iteration, and `runner.ts:236` has no
   * `try`/`catch` — so a single unresolvable declaration aborts that
   * collection's entire pre-flight and takes every audit after it down with it.
   *
   * `posts.reply_permission` was exactly this: declaration 11 of 21 on the
   * largest collection, silently disabling the ten that follow, including
   * `authorship.role` and `authorship.status`. Nothing noticed, because
   * `auditEnums` is exercised against five collections in the whole suite and
   * `posts` is not one of them — so the tool everyone believed was the external
   * referent had never run where it mattered most.
   *
   * The runner SHOULD keep aborting: a swallowed declaration error becomes a
   * vacuous audit, which is a worse failure than a loud halt. This case is what
   * moves the halt from the cutover window into CI, where it costs nothing.
   */
  it('resolves every enumAudit declaration in every plan', () => {
    const broken: string[] = [];
    let declarations = 0;
    let plansWithAudits = 0;
    for (const plan of COLLECTION_PLANS) {
      const audits = plan.enumAudits ?? [];
      if (audits.length > 0) plansWithAudits++;
      for (const audit of audits) {
        declarations++;
        const column = audit.column as unknown as { table: PgTable; name: string };
        const table = getTableConfig(column.table).name;
        try {
          const values = allowedValues(audit.column);
          if (values.length === 0) {
            broken.push(`${table}.${column.name} (${plan.collection}:${audit.path}) — empty set`);
          }
        } catch (error) {
          broken.push(
            `${table}.${column.name} (${plan.collection}:${audit.path}) — ${(error as Error).message}`
          );
        }
      }
    }
    // A vacuity floor for the loop itself: a `COLLECTION_PLANS` that stopped
    // exporting anything, or an `enumAudits` that got renamed, would otherwise
    // make "nothing broken" the passing answer.
    expect(plansWithAudits).toBeGreaterThan(20);
    expect(declarations).toBeGreaterThan(80);
    expect(broken.join('\n')).toBe('');
  });
});
