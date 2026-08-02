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

import type { CollectionPlan, EnumAudit, UniquenessNormalization } from './plan';
import { allowedValues } from './plan';
import type { MongoSource } from './mongoSource';
import type { ResolutionContext, ResolutionRule } from './resolutions';

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
    | 'uniqueness'
    | 'referential-integrity'
    | 'dropped-document'
    | 'resolution-overreach';
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
 * Find groups of documents that collide under a uniqueness rule Postgres
 * enforces and Mongo did not.
 *
 * Implemented as one `$group` over the normalized key. `$toLower` is applied to
 * the case-insensitive paths, which is the same normalization the Postgres
 * expression index applies: both are SIMPLE case mapping. (It is JavaScript's
 * `String.toLowerCase()` that applies FULL case mapping and differs, and no
 * part of this audit uses it.)
 */
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
        { $sort: { count: -1 } },
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
    finding.kind === 'uniqueness' ||
    // A referential finding blocks whether or not the column is NULLABLE.
    // Nullable means SQL NULL is accepted, not that a value naming no row is:
    // both are `23503`. Nullability changes what the report RECOMMENDS, never
    // whether the copy may start.
    finding.kind === 'referential-integrity' ||
    // A transform that emitted fewer rows than it read documents is losing
    // data, and it blocks even with no foreign key pointing at the lost rows.
    // This is one of the two finding classes a resolution rule must never
    // answer: the bug is in the transform, and `resolvedBy` clearing it would
    // be the migration silently agreeing to lose documents.
    finding.kind === 'dropped-document' ||
    // The other one, and the mirror image: a documented rule that acted on a
    // row whose parent EXISTS is removing or altering live data. Nothing may
    // clear it — least of all another rule.
    finding.kind === 'resolution-overreach'
  );
}
