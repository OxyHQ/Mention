/**
 * Pre-flight audits — run against the LIVE source, before a single row is
 * inserted.
 *
 * Everything here answers one question: which production documents would the
 * Postgres schema refuse, and why? Finding out during the copy is far worse
 * than finding out first — a `23514` three hours into a `posts` run names a
 * constraint, not a row, and by then the operator has to choose between
 * aborting a partial migration and hand-patching data under time pressure.
 *
 * ## Why an enum audit is necessary at all
 *
 * Mongoose validators only run on documents saved through a MODEL, and this
 * package never sets `runValidators` on its update paths — so an `enum:` in
 * `src/models/` is documentation, not a constraint. Live data can hold values
 * the schema forbids. A Postgres CHECK **is** enforced. Every such value is a
 * row the migration would reject, and every one is reported here with its
 * count.
 *
 * The audit reads the allowed set from the drizzle COLUMN, never from a list
 * repeated here, so it predicts the CHECK rather than a copy of it.
 *
 * ## Why a NUMERIC audit is necessary, and why one had to be built
 *
 * An `EnumAudit` can only read `column.enumValues`, which no numeric column
 * carries — so for a while this file's coverage stopped at text and the ~40
 * numeric CHECKs in this schema were unaudited, `likes.value in (1, -1)` among
 * them. That was recorded as a hole rather than left silent, and the recorded
 * reason ("closing it needs a numeric-range audit the framework does not have")
 * was correct about the framework and wrong about the difficulty: `distinct()`
 * is the same instrument, and it returns numbers as readily as strings.
 *
 * The class matters more than the one constraint that exposed it. Most of those
 * CHECKs are `>= 0` on a DENORMALIZED COUNTER copied straight out of Mongo, and
 * a counter driven below zero by a decrement race is the most ordinary way a
 * Mongo integer lands outside a range nobody was enforcing. `auditNumerics`
 * covers sets and bounds alike; see {@link NumericAudit} for why the accepted
 * SET is read from the schema's own constant while a BOUND has to be declared.
 *
 * ## Why a uniqueness audit is necessary
 *
 * Postgres now enforces unique indexes Mongo lacked — case-insensitive ones
 * especially, which Mongo has no collation for. Two rows differing only by case
 * are legal in Mongo today and collide here. The audit reports the colliding
 * GROUPS — both sides, with their ids — rather than letting the copy fail on
 * the second one, because "which of these two is the real one" is a decision
 * for a human and the report is what that decision needs.
 *
 * ## Why a referential-integrity audit is necessary
 *
 * It lives in `referentialIntegrity.ts` because it is the one audit that cannot
 * be a query — it has to run the plans' own transforms — but it belongs to this
 * phase and reports through the same {@link AuditFinding}. Its absence is what
 * let the sibling migration report CLEAN here and then die on a foreign key
 * partway through level 2 of 6: Mongo enforced no foreign key, so a document
 * naming a deleted parent was legal there and is `23503` here.
 *
 * ## Findings are not warnings
 *
 * A finding blocks the copy unless a DOCUMENTED RESOLUTION RULE answers it. The
 * runner refuses to copy a collection with a blocking finding, and there is
 * still no override flag: the three ways forward are to fix the data, to widen
 * the schema, or to teach the migration what to do — all decisions, none a
 * switch. The third is `resolutions.ts`, and taking it does not silence
 * anything: the finding is still computed, still counted and still printed, now
 * carrying the rule that answers it.
 */

import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { CollectionPlan, EnumAudit, NumericAudit, UniquenessNormalization } from './plan';
import { allowedValues, describeNumericBound, numericIsAccepted, tableName } from './plan';
import type { MongoSource } from './mongoSource';
import { streamCollection } from './mongoSource';
import type { ResolutionContext, ResolutionRule } from './resolutions';
import { parentKeysFrom, transformDocument } from './resolutions';
import { tableShape } from './rowBuilder';

/** One thing the schema would refuse — or one thing wrong with a rule. */
export interface AuditFinding {
  readonly collection: string;
  /**
   * The last two kinds are not about the DATA. They say a transform is losing
   * documents, or that a documented rule acted on a row it was not written for
   * — and neither may ever be answered by a rule, for the same reason: the
   * migration would be agreeing with itself.
   */
  readonly kind:
    | 'enum'
    | 'numeric'
    | 'uniqueness'
    | 'referential-integrity'
    | 'undetected-relation'
    | 'dropped-document'
    | 'resolution-overreach'
    | 'defaulted-column'
    | 'stale-acknowledgement';
  /** Human-readable, and specific enough to act on without opening the code. */
  readonly detail: string;
  /** Documents affected, where the audit can count them. */
  readonly documents: number;
  /** A few offending `_id`s, so the operator can look at real rows. */
  readonly sampleIds: readonly string[];
  /**
   * The documented rule that already answers this finding, when one does.
   *
   * Never something a caller supplies. It is set from a rule the PLAN declared
   * on the audit that produced the finding — and only when that rule verifiably
   * covers this particular finding: for a uniqueness collision, when it acts on
   * all but one of the colliding rows. A finding carrying one is reported in
   * full and does not block; see {@link auditWouldBlockCopy}.
   */
  readonly resolvedBy?: ResolutionRule;
}

/** How many colliding/offending ids to quote per finding. */
const SAMPLE_LIMIT = 5;

/**
 * A document where a REQUIRED field is missing entirely — which `distinct`
 * cannot see.
 *
 * This is the hole that makes the null branches of the two audits below only
 * half a check, and it is not obvious from either: **Mongo's `distinct` omits a
 * missing field altogether**. `distinct('followerCount')` over a collection
 * whose every document lacks the field returns `[]`, not `[null]` — measured
 * against a real server, and it is what made a case asserting the opposite go
 * red. An EXPLICIT `null` does appear in the set, so the two states that Mongo
 * treats as interchangeable everywhere else are distinguishable here, and only
 * one of them was being checked.
 *
 * The consequence without this probe: a `NOT NULL` column with no default and a
 * source document that never had the field passes every audit, and then
 * `buildRow` throws mid-copy — one document, no count, no sample, and a
 * half-migrated database. Which is the precise outcome the audit phase exists
 * to prevent.
 *
 * `$exists: false` is the right predicate rather than `$eq: null`, and the
 * difference is the same trap in the other direction: `{field: null}` matches
 * BOTH a missing field and an explicit null, so it would double-report every
 * value `distinct` already found. Together the two are exact and disjoint.
 */
async function auditMissingRequired(
  source: MongoSource,
  plan: CollectionPlan,
  path: string,
  column: PgColumn,
  kind: AuditFinding['kind'],
  refusedBy: string,
  resolvedBy: ResolutionRule | undefined
): Promise<AuditFinding | null> {
  const collection = source.collection(plan.collection);
  const filter = { [path]: { $exists: false } } as Record<string, unknown>;
  const documents = await collection.countDocuments(filter);
  if (documents === 0) return null;
  const samples = await collection
    .find(filter, { projection: { _id: 1 }, limit: SAMPLE_LIMIT })
    .toArray();
  return {
    collection: plan.collection,
    kind,
    detail:
      `${plan.collection}.${path} is MISSING from ${documents} document(s), and ` +
      `${column.name} is NOT NULL with no default and no declared substitute. ` +
      `${refusedBy} would reject these rows with a 23502. Mongo's \`distinct\` ` +
      'does not report a missing field at all, so this is checked separately.',
    documents,
    sampleIds: samples.map((doc) => String(doc._id)),
    ...(resolvedBy === undefined ? {} : { resolvedBy }),
  };
}

/**
 * Check every enum-backed column of a plan against `distinct()` on the source.
 *
 * `distinct` is the right instrument: it is a single index-assisted pass that
 * returns the VALUE SET rather than the documents, so it costs about the same
 * on a 300,000-document collection as on a 20-document one — which is what
 * makes it affordable to run over everything before touching anything.
 */
export async function auditEnums(
  source: MongoSource,
  plan: CollectionPlan
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  for (const audit of plan.enumAudits ?? []) {
    const allowed = new Set(allowedValues(audit.column));
    const collection = source.collection(plan.collection);
    const observed = await collection.distinct(audit.path, {});

    // A field that is MISSING rather than null — see `auditMissingRequired`.
    if (audit.column.notNull && audit.absentAs === undefined) {
      const missing = await auditMissingRequired(
        source,
        plan,
        audit.path,
        audit.column,
        'enum',
        `${audit.column.name} is NOT NULL, so Postgres`,
        audit.resolvedBy
      );
      if (missing !== null) findings.push(missing);
    }

    for (const value of observed) {
      if (value === null || value === undefined) {
        // A NULL in a NULLABLE column is not a finding at all, and reporting it
        // would be a FALSE POSITIVE on every optional enum field in the schema.
        //
        // `NULL in ('a','b')` evaluates to NULL, and a CHECK is satisfied by
        // anything that is not FALSE, so Postgres ACCEPTS the row:
        //
        //     create table _chk (r text, constraint c check (r in ('a','b')));
        //     insert into _chk values (null);    -- INSERT 0 1   (accepted)
        //     insert into _chk values ('bogus'); -- ERROR: violates check constraint
        //
        // An audit that cries wolf gets disabled by whoever hits it next, and
        // this one is the gate on a production data migration.
        if (!audit.column.notNull) continue;
        // A NOT NULL column is a different question: nothing about a CHECK is
        // involved, `23502` is, and `absentAs` is the plan declaring that the
        // transform substitutes a default before the value ever gets there.
        if (audit.absentAs !== undefined) continue;
        findings.push(
          await describeEnumFinding(
            source,
            plan,
            audit,
            null,
            'is absent/null and no default is declared',
            `${audit.column.name} is NOT NULL, so Postgres`
          )
        );
        continue;
      }
      if (typeof value !== 'string') {
        findings.push(
          await describeEnumFinding(
            source,
            plan,
            audit,
            value,
            `is ${typeof value}, but the column is text`,
            `The CHECK on ${audit.column.name}`
          )
        );
        continue;
      }
      if (allowed.has(value)) continue;
      findings.push(
        await describeEnumFinding(
          source,
          plan,
          audit,
          value,
          `is not one of ${[...allowed].join(' | ')}`,
          `The CHECK on ${audit.column.name}`
        )
      );
    }
  }
  return findings;
}

async function describeEnumFinding(
  source: MongoSource,
  plan: CollectionPlan,
  audit: EnumAudit,
  value: unknown,
  why: string,
  refusedBy: string
): Promise<AuditFinding> {
  const collection = source.collection(plan.collection);
  const filter = { [audit.path]: value } as Record<string, unknown>;
  const documents = await collection.countDocuments(filter);
  const samples = await collection
    .find(filter, { projection: { _id: 1 }, limit: SAMPLE_LIMIT })
    .toArray();
  return {
    collection: plan.collection,
    kind: 'enum',
    detail:
      `${plan.collection}.${audit.path} = ${JSON.stringify(value)} ${why}. ` +
      `${refusedBy} would reject these rows.`,
    documents,
    sampleIds: samples.map((doc) => String(doc._id)),
    ...(audit.resolvedBy === undefined ? {} : { resolvedBy: audit.resolvedBy }),
  };
}

/**
 * Check every numeric-CHECK column of a plan against `distinct()` on the source.
 *
 * Same instrument as {@link auditEnums} and the same cost profile — `distinct`
 * returns the VALUE SET, so this is affordable over every collection before
 * anything is written. The only real difference is what the accepted set is
 * read from: a text enum has `column.enumValues`, a numeric CHECK has nothing
 * structured at all, so the plan declares it (see {@link NumericAudit}).
 *
 * One caveat that is worth stating rather than discovering: `distinct` on a
 * column holding thousands of distinct counter values returns thousands of
 * numbers. That is still one index-assisted pass and the comparison is O(n) in
 * the SET, not in the documents — but it is why the countDocuments/sample
 * lookup below runs only for a value that actually violates, never per value.
 */
export async function auditNumerics(
  source: MongoSource,
  plan: CollectionPlan
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  for (const audit of plan.numericAudits ?? []) {
    const collection = source.collection(plan.collection);
    const observed = await collection.distinct(audit.path, {});

    // A field that is MISSING rather than null — see `auditMissingRequired`.
    if (audit.column.notNull && audit.absentAs === undefined) {
      const missing = await auditMissingRequired(
        source,
        plan,
        audit.path,
        audit.column,
        'numeric',
        `${audit.column.name} is NOT NULL, so Postgres`,
        audit.resolvedBy
      );
      if (missing !== null) findings.push(missing);
    }

    for (const value of observed) {
      if (value === null || value === undefined) {
        // Identical reasoning to the enum audit's null branch, and it holds for
        // the same measured reason: `NULL >= 0` is NULL, a CHECK is satisfied by
        // anything that is not FALSE, so Postgres ACCEPTS a NULL in a nullable
        // column. Reporting it would be a false positive on every optional
        // numeric field in the schema.
        if (!audit.column.notNull) continue;
        // A NOT NULL column raises `23502`, not `23514` — a different failure
        // that a CHECK has nothing to do with. `absentAs` is the plan declaring
        // the transform substitutes a default before the value gets there.
        if (audit.absentAs !== undefined) continue;
        findings.push(
          await describeNumericFinding(
            source,
            plan,
            audit,
            null,
            `is absent/null and no default is declared, but ${audit.column.name} is NOT NULL`
          )
        );
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        // A string where a number belongs is the shape that survives Mongo
        // happily and dies on the INSERT: `integer` refuses it outright, and a
        // NaN/Infinity has no Postgres representation at all.
        findings.push(
          await describeNumericFinding(
            source,
            plan,
            audit,
            value,
            `is ${typeof value === 'number' ? String(value) : typeof value}, ` +
              'which no Postgres numeric column accepts'
          )
        );
        continue;
      }
      if (numericIsAccepted(audit, value)) continue;
      findings.push(
        await describeNumericFinding(
          source,
          plan,
          audit,
          value,
          `is not ${describeNumericBound(audit)}`
        )
      );
    }
  }
  return findings;
}

async function describeNumericFinding(
  source: MongoSource,
  plan: CollectionPlan,
  audit: NumericAudit,
  value: unknown,
  why: string
): Promise<AuditFinding> {
  const collection = source.collection(plan.collection);
  const filter = { [audit.path]: value } as Record<string, unknown>;
  const documents = await collection.countDocuments(filter);
  const samples = await collection
    .find(filter, { projection: { _id: 1 }, limit: SAMPLE_LIMIT })
    .toArray();
  return {
    collection: plan.collection,
    kind: 'numeric',
    detail:
      `${plan.collection}.${audit.path} = ${JSON.stringify(value)} ${why}. ` +
      `${audit.constraint} would reject these rows.`,
    documents,
    sampleIds: samples.map((doc) => String(doc._id)),
    ...(audit.resolvedBy === undefined ? {} : { resolvedBy: audit.resolvedBy }),
  };
}

/**
 * Find groups of documents that collide under a uniqueness rule Postgres
 * enforces and Mongo did not.
 *
 * Implemented as one `$group` over the normalized key. `$toLower` is applied to
 * the case-insensitive paths, which is the same normalization the Postgres
 * expression index applies: both are SIMPLE case mapping. (It is JavaScript's
 * `String.toLowerCase()` that applies FULL case mapping and differs, and no
 * part of this audit uses it.)
 */
/**
 * Every `NOT NULL DEFAULT` column the transform leaves to the database, and how
 * many documents it leaves it for.
 *
 * ## Why silence from the other audits is not evidence here
 *
 * The audits above ask what the DATA contains. This one asks what the TRANSFORM
 * omits, which is a different question and the only one that can see this class.
 * A `NOT NULL` column with no default raises `23502` when a value is missing, so
 * `buildRow` catches it while the document is in hand. A `NOT NULL` column WITH
 * a default raises nothing: the row inserts, Postgres supplies the value, and a
 * source field that was absent silently becomes a value nobody chose.
 *
 * Measured, which is why this exists at all: six posts of 577,526 in production
 * carry no `createdAt`, and `posts.created_at` is exactly this shape. Left
 * alone, all six would take `now()` and sit at the top of every chronological
 * feed on day one — no error, no finding, nothing to notice.
 *
 * ## It reports rather than decides
 *
 * Both answers are legitimate and they are not interchangeable. A counter with
 * no source field genuinely should default to zero; a creation timestamp should
 * not be invented. So the finding carries the COUNT and sample ids, and the plan
 * records which answer it took — deriving the value (`posts` now does) or
 * declaring the default correct (`defaultedColumns`).
 *
 * ## The acknowledgement list is re-measured, never trusted
 *
 * An acknowledgement for a column the transform ALWAYS supplies is reported as
 * `stale-acknowledgement`. An exemption list nobody re-checks is how a gate
 * becomes a formality, and this one describes transform behaviour that changes
 * under it — the same reason the referential audit reconciles its derived
 * relations against `pg_constraint` instead of believing its own derivation.
 *
 * Streaming, because the question is about emitted ROWS and only running the
 * transform can answer it. Nothing is written and nothing is inserted.
 */
export async function auditDefaultedColumns(
  source: MongoSource,
  plan: CollectionPlan,
  resolutions: ResolutionContext,
  options: { readonly batchSize?: number } = {}
): Promise<AuditFinding[]> {
  const batchSize = options.batchSize ?? 1000;

  // (table property name, column property name) -> how many rows omitted it.
  const omissions = new Map<string, { table: PgTable; property: string; rows: number; ids: string[] }>();
  const rowsPerTable = new Map<string, number>();

  // The rules cannot be asked anything here: their parent sets belong to the
  // referential audit's own two phases, and an empty `ParentKeys` throws rather
  // than answering from an empty map.
  const noParents = parentKeysFrom(new Map());

  for await (const documents of streamCollection(source, plan.collection, batchSize)) {
    for (const doc of documents) {
      const documentId = describeDocumentId(doc);
      transformDocument(plan, doc, resolutions, noParents, (row) => {
        // `source`, not `written`: a row a rule drops still says what the
        // transform decided, and measuring only surviving rows would let a rule
        // hide the omission rather than answer it.
        const name = tableName(row.table);
        rowsPerTable.set(name, (rowsPerTable.get(name) ?? 0) + 1);
        for (const property of tableShape(row.table).defaulted) {
          if (property in row.source) continue;
          const key = `${name}.${property}`;
          const entry = omissions.get(key) ?? {
            table: row.table,
            property,
            rows: 0,
            ids: [],
          };
          entry.rows += 1;
          if (entry.ids.length < SAMPLE_LIMIT && documentId !== undefined) {
            entry.ids.push(documentId);
          }
          omissions.set(key, entry);
        }
      });
    }
  }

  const acknowledged = new Map(
    (plan.defaultedColumns ?? []).map((entry) => [
      `${entry.column.name}`,
      entry,
    ])
  );

  const findings: AuditFinding[] = [];
  const seenProperties = new Set<string>();

  for (const [key, entry] of [...omissions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    seenProperties.add(entry.property);
    if (acknowledged.has(entry.property)) continue;
    const total = rowsPerTable.get(tableName(entry.table)) ?? 0;
    findings.push({
      collection: plan.collection,
      kind: 'defaulted-column',
      detail:
        `${key} is NOT NULL with a DEFAULT and the transform omits it for ` +
        `${entry.rows} of ${total} rows, so Postgres supplies the value. That is ` +
        'silent by construction — no error, no rejected row. Decide which it is: ' +
        'DERIVE the value (as `posts.created_at` now does from the ObjectId), or ' +
        'declare the default correct for this column in the plan\'s ' +
        '`defaultedColumns` with the reason it is right.',
      documents: entry.rows,
      sampleIds: entry.ids,
    });
  }

  for (const [property, entry] of acknowledged) {
    if (seenProperties.has(property)) continue;
    findings.push({
      collection: plan.collection,
      kind: 'stale-acknowledgement',
      detail:
        `${tableName(plan.table)}.${property} carries a defaultedColumns ` +
        `acknowledgement ("${entry.reason}") but the transform SUPPLIES it for ` +
        'every row, so the acknowledgement describes behaviour that no longer ' +
        'happens. Remove it — an exemption nobody re-measures is how this gate ' +
        'turns into a formality.',
      documents: 0,
      sampleIds: [],
    });
  }

  return findings;
}

/** The document `_id` as a string, for a sample list. */
function describeDocumentId(doc: Record<string, unknown>): string | undefined {
  const id = doc._id;
  return id === null || id === undefined ? undefined : String(id);
}

export async function auditUniqueness(
  source: MongoSource,
  plan: CollectionPlan,
  resolutions: ResolutionContext
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  for (const audit of plan.uniquenessAudits ?? []) {
    // Postgres unique indexes are NULLS DISTINCT: a row with a NULL in ANY
    // indexed column never conflicts. Excluding those rows is not an
    // optimisation — including them reports every sparse row as colliding with
    // every other, which is a false positive on exactly the columns most likely
    // to be sparse.
    const present: Record<string, unknown> = {};
    for (const part of audit.key) {
      present[part.path] = { $nin: [null, undefined] };
    }
    // A PARTIAL index constrains only the rows its predicate selects, so the
    // audit has to ask the same narrower question — see `UniquenessAudit.where`.
    // Spread LAST so a predicate on an indexed column wins over the presence
    // filter above rather than being silently dropped by key collision.
    const scope: Record<string, unknown> = { ...present, ...(audit.where ?? {}) };

    const groupKey: Record<string, unknown> = {};
    for (const part of audit.key) {
      groupKey[keyAlias(part.path)] = normalizedExpression(part.path, part.normalize);
    }

    const groups = await source
      .collection(plan.collection)
      .aggregate([
        { $match: scope },
        { $group: { _id: groupKey, count: { $sum: 1 }, ids: { $push: '$_id' } } },
        { $match: { count: { $gt: 1 } } },
        // `count` alone is a TIE among every group of the same size, and the
        // `$limit` below then keeps an arbitrary 50 of them — so an operator
        // fixes the reported collisions, re-runs, and is handed a DIFFERENT 50
        // with no indication that the first report was a sample. `_id` is the
        // group key and is unique per group, so appending it makes the order
        // total and the truncation reproducible.
        { $sort: { count: -1, _id: 1 } },
        { $limit: 50 },
      ])
      .toArray();

    for (const group of groups) {
      const ids = (Array.isArray(group.ids) ? group.ids : []).map((value: unknown) =>
        String(value)
      );
      // A rule declared on this audit only COVERS the group when it actually
      // acts on all but one of its rows. Asked of the resolution, so this file
      // needs no knowledge of any particular rule — and it fails CLOSED, so a
      // collision the rule was not written for still blocks.
      const resolvedBy =
        audit.resolvedBy !== undefined &&
        resolutions.resolvesUniquenessGroup(audit.resolvedBy, ids)
          ? audit.resolvedBy
          : undefined;
      findings.push({
        collection: plan.collection,
        kind: 'uniqueness',
        detail:
          `${audit.index} would reject ${group.count} documents sharing the key ` +
          `${JSON.stringify(group._id)} (normalized as ` +
          `${audit.key.map((part) => `${part.path}:${part.normalize}`).join(', ')}). ` +
          'Mongo allowed them to coexist; Postgres will not. ' +
          (resolvedBy === undefined
            ? 'Decide which row survives — the migration must not choose.'
            : 'Which row survives is DECIDED, not guessed — see the resolution rule.'),
        documents: typeof group.count === 'number' ? group.count : ids.length,
        sampleIds: ids.slice(0, SAMPLE_LIMIT),
        ...(resolvedBy === undefined ? {} : { resolvedBy }),
      });
    }
  }
  return findings;
}

/**
 * The Mongo expression matching one column's index expression.
 *
 * `$toLower` and Postgres `lower()` both apply SIMPLE case mapping, so they
 * agree. `$trim` with no `chars` strips whitespace, as `btrim` with no second
 * argument does.
 */
function normalizedExpression(path: string, normalize: UniquenessNormalization): unknown {
  const field = `$${path}`;
  if (normalize === 'exact') return field;
  if (normalize === 'lower') return { $toLower: field };
  return { $toLower: { $trim: { input: field } } };
}

/** `$group` keys cannot contain a dot; `content.text` becomes `content__text`. */
function keyAlias(path: string): string {
  return path.replace(/\./g, '__');
}

/**
 * Every finding blocks the copy — unless a documented rule already answers it.
 *
 * Written as a function rather than assumed, so a future finding class that is
 * genuinely advisory has one place to say so — and so the runner's refusal
 * reads as a decision rather than an accident.
 *
 * `resolvedBy` is NOT an override flag and cannot be used as one. Nothing a
 * caller passes reaches it: it is set only when the PLAN declares a rule on the
 * very audit that produced the finding, and — for a uniqueness collision — only
 * when the rule verifiably acts on all but one of the colliding rows. The
 * finding is still computed, still counted, and still printed. Silencing a
 * check remains impossible; teaching the migration what to do is the move.
 */
export function auditWouldBlockCopy(finding: AuditFinding): boolean {
  if (finding.resolvedBy !== undefined) return false;
  return (
    finding.kind === 'enum' ||
    // A numeric CHECK is `23514`, exactly as an enum CHECK is, and blocks for
    // the same reason: the row is refused by the server, so the alternative to
    // stopping now is stopping at hour three with a partly-migrated database.
    finding.kind === 'numeric' ||
    finding.kind === 'uniqueness' ||
    // A referential finding blocks whether or not the column is NULLABLE.
    // Nullable means SQL NULL is accepted, not that a value naming no row is:
    // both are `23503`. Nullability changes what the report RECOMMENDS, never
    // whether the copy may start.
    finding.kind === 'referential-integrity' ||
    // A foreign key Postgres HAS and this audit never derived. Kept apart from
    // every other class on purpose: it is a defect in the CHECKER, not in the
    // data, so there is nothing an operator could fix in Mongo to clear it and
    // no resolution rule may ever answer it — a rule clearing it would be the
    // migration excusing its own blind spot.
    finding.kind === 'undetected-relation' ||
    // A transform that emitted fewer rows than it read documents is losing
    // data, and it blocks even with no foreign key pointing at the lost rows.
    // This is one of the two finding classes a resolution rule must never
    // answer: the bug is in the transform, and `resolvedBy` clearing it would
    // be the migration silently agreeing to lose documents.
    finding.kind === 'dropped-document' ||
    // The other one, and the mirror image: a documented rule that acted on a
    // row whose parent EXISTS is removing or altering live data. Nothing may
    // clear it — least of all another rule.
    finding.kind === 'resolution-overreach' ||
    // A `NOT NULL DEFAULT` column the transform omits. It blocks even though
    // the row would insert cleanly, and BECAUSE it would: every other blocking
    // class is something Postgres refuses, so stopping the run is the cheaper
    // of two failures. This one Postgres accepts, which means an un-blocked
    // finding is a value nobody chose landing in production with nothing left
    // to notice it afterwards. The way past is a DECISION recorded in the plan
    // (derive the value, or `defaultedColumns` with the reason the default is
    // right), which is the same shape as the other two ways forward and not a
    // switch. `resolvedBy` cannot clear it either — nothing sets one on this
    // kind, because a resolution rule answering a question about the
    // TRANSFORM's behaviour would be the migration agreeing with itself.
    finding.kind === 'defaulted-column' ||
    // An acknowledgement for a column the transform always supplies. A defect
    // in the PLAN rather than in the data, same family as
    // `undetected-relation`: there is nothing to fix in Mongo, and a stale
    // exemption is exactly how this gate would decay into a formality.
    finding.kind === 'stale-acknowledgement'
  );
}
