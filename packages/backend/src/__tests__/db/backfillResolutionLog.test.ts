/**
 * The durable resolution log — the record of what the migration did, kept where
 * it can be read whole.
 *
 * Run 10's printed report exceeded CloudWatch's 10,000-event page and truncated
 * MID-REPORT, and the read was indistinguishable from a run that produced no
 * verdict at all. The cutover's log is strictly larger and its content is the
 * record of what we did to production, so it needs a home that a page limit
 * cannot silently cut in half.
 *
 * The failure this file exists to catch is the quiet one: a log that writes
 * NOTHING, or writes a summary instead of the ids. Both leave a clean-looking
 * run with no recoverable audit trail, and neither is visible from the printed
 * report — which is why the CLI prints the written count beside the report's
 * own total, two numbers from two paths that must agree.
 *
 * Fixtures are `brl-` prefixed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { assertBookkeepingTableExists } from '../../db/backfill/bookkeepingTables';
import { RESOLUTION_LOG_TABLE, writeResolutionLog } from '../../db/backfill/resolutionLogStore';
import {
  RESOLUTION_RULES,
  ResolutionLog,
  type ResolutionSummary,
} from '../../db/backfill/resolutions';

const RUN_A = 'brl-run-a';
const RUN_B = 'brl-run-b';

/** A real declared rule, so the log is keyed by something that exists. */
const rule = () => {
  const found = RESOLUTION_RULES.find(
    (candidate) => candidate.id === 'drop-boost-of-a-post-mention-never-held'
  );
  if (!found) throw new Error('the boost rule is not declared');
  return found;
};

const summaryOf = (documentIds: readonly string[]): ResolutionSummary[] => [
  {
    rule: rule(),
    documents: documentIds.length,
    documentIds: [...documentIds],
    records: documentIds.map((documentId) => ({
      rule: rule(),
      documentId,
      detail: `brl detail for ${documentId}`,
      evidence: { 'posts.type': 'boost' },
    })),
  },
];

async function rowsFor(runId: string) {
  return getDb().execute<{ document_id: string; detail: string; evidence: unknown }>(
    sql`select document_id, detail, evidence from ${sql.identifier(RESOLUTION_LOG_TABLE)}
        where run_id = ${runId} order by document_id`
  );
}

beforeAll(async () => {
  await connectPostgres();
  await assertBookkeepingTableExists(getDb(), RESOLUTION_LOG_TABLE);
}, 120_000);

afterEach(async () => {
  await getDb().execute(
    sql`delete from ${sql.identifier(RESOLUTION_LOG_TABLE)} where run_id in (${RUN_A}, ${RUN_B})`
  );
});

afterAll(async () => {
  await closePostgres();
});

describe('the resolution log', () => {
  it('persists EVERY record by id, not a count', async () => {
    // More than a handful, because "it wrote something" and "it wrote all of
    // it" are different claims and only the second one is useful after a
    // cutover.
    const ids = Array.from({ length: 120 }, (_, index) => `brl-doc-${String(index).padStart(3, '0')}`);

    const written = await writeResolutionLog(getDb(), RUN_A, summaryOf(ids));
    expect(written).toBe(ids.length);

    const rows = await rowsFor(RUN_A);
    expect(rows.map((row) => row.document_id)).toStrictEqual(ids);
    expect(rows[0]?.detail).toBe('brl detail for brl-doc-000');
    // The evidence survives as queryable json rather than a string.
    expect(rows[0]?.evidence).toStrictEqual({ 'posts.type': 'boost' });
  });

  it('crosses its batch boundary without losing or duplicating a row', async () => {
    // The writer batches at 500. A fixture below that size cannot see an
    // off-by-one at the boundary, and a cutover is far above it.
    const ids = Array.from({ length: 1001 }, (_, index) => `brl-b-${String(index).padStart(4, '0')}`);

    const written = await writeResolutionLog(getDb(), RUN_A, summaryOf(ids));
    expect(written).toBe(1001);

    const rows = await rowsFor(RUN_A);
    expect(rows).toHaveLength(1001);
    expect(new Set(rows.map((row) => row.document_id)).size).toBe(1001);
  });

  it('keeps runs separable, so a re-run does not merge into its predecessor', async () => {
    await writeResolutionLog(getDb(), RUN_A, summaryOf(['brl-shared-1']));
    await writeResolutionLog(getDb(), RUN_B, summaryOf(['brl-shared-1', 'brl-only-b']));

    expect((await rowsFor(RUN_A)).map((row) => row.document_id)).toStrictEqual(['brl-shared-1']);
    expect((await rowsFor(RUN_B)).map((row) => row.document_id)).toStrictEqual([
      'brl-only-b',
      'brl-shared-1',
    ]);
  });

  it('keeps what earlier levels decided when a later one DIES', async () => {
    // The property the per-level drain exists for, exercised the way it fails:
    // the trail was written once, after the copy returned, so a run that died
    // wrote NOTHING — empty for exactly the runs whose record matters. A failed
    // 26-minute attempt resolved hundreds of rows and recorded none.
    //
    // `finally` is not the fix and the fixture would not catch its failure
    // anyway: a write issued on a connection whose transaction has aborted
    // executes nothing until a rollback, while raising nothing and reading as
    // handled. Draining as the copy goes means the rows are already durable
    // when the failure happens, which is what this asserts.
    const log = new ResolutionLog();
    const record = (documentId: string) =>
      log.record({ rule: rule(), documentId, detail: `brl level detail ${documentId}` });

    record('brl-level1-a');
    record('brl-level1-b');
    await writeResolutionLog(getDb(), RUN_A, log.drain());

    record('brl-level2-a');
    await writeResolutionLog(getDb(), RUN_A, log.drain());

    // …and here the run dies. Nothing else is written.
    expect((await rowsFor(RUN_A)).map((row) => row.document_id)).toStrictEqual([
      'brl-level1-a',
      'brl-level1-b',
      'brl-level2-a',
    ]);
  });

  it('does not write a record twice when a later drain follows an earlier one', async () => {
    // The other half, and the one that makes the per-level write safe: a
    // transform is re-run several times per document, so the same record is
    // re-`record`ed under the same key. A drain that re-handed everything would
    // turn one cutover into three copies of its own audit trail — and the CLI's
    // "written vs claimed" check would then read as a mismatch on a healthy run.
    const log = new ResolutionLog();
    log.record({ rule: rule(), documentId: 'brl-dup', detail: 'brl first' });
    expect(await writeResolutionLog(getDb(), RUN_A, log.drain())).toBe(1);

    // Recorded AGAIN, exactly as a re-run transform does.
    log.record({ rule: rule(), documentId: 'brl-dup', detail: 'brl first' });
    expect(await writeResolutionLog(getDb(), RUN_A, log.drain())).toBe(0);

    expect(await rowsFor(RUN_A)).toHaveLength(1);
    // And the complete summary still reports it, because the REPORT and the
    // WRITER ask different questions of the same log.
    expect(
      log.summary().flatMap((entry) => entry.documentIds)
    ).toStrictEqual(['brl-dup']);
  });

  it('writes nothing, and says so, when no rule acted', async () => {
    const written = await writeResolutionLog(getDb(), RUN_A, [
      { rule: rule(), documents: 0, documentIds: [], records: [] },
    ]);
    expect(written).toBe(0);
    // `toHaveLength`, not `toStrictEqual([])`: the driver returns an array-LIKE
    // Result whose prototype is not Array, so the empty comparison fails on a
    // difference that has nothing to do with the rows.
    expect(await rowsFor(RUN_A)).toHaveLength(0);
  });
});
