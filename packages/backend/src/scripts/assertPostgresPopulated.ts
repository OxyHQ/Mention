/**
 * Refuse the rollout when the database it is about to serve is EMPTY.
 *
 * ## What this is for
 *
 * On 2026-08-04 a trunk image went live against an empty Postgres. Every
 * post-deploy smoke check passed — `GET /feed/mtn` answers 200 with
 * `{"data":{"items":[]}}` when the store holds nothing, so "the process
 * answered" was standing in for "the process has a database behind it". What
 * reverted the deployment was an unrelated post-deploy task crashing. The
 * breakage was load-bearing, and this is the control that replaces it.
 *
 * It runs as a pre-rollout one-shot in `deploy-ecs-image.sh`, after the schema
 * migration (the tables have to exist before rows can be counted) and before
 * `update-service`. A non-zero exit there stops the release having routed
 * nothing, which is the whole reason it lives at that point rather than in the
 * post-deploy smoke: a smoke failure rolls back after the image has served.
 *
 * ## READ-ONLY, deliberately
 *
 * A one-shot that fails may still be RUNNING against the database afterwards —
 * the deploy role cannot call `ecs:StopTask`, which `deploy-ecs-image.sh` warns
 * about in its own comments. Anything this file did to the data could therefore
 * still be happening after the deploy gave up. It counts and it exits.
 *
 * ## IT ASSERTS SOMETHING TRUE ONLY OF THIS DEPLOYMENT
 *
 * "Postgres is authoritative and populated" is a claim about production, not
 * about the application, which is the objection that kept this out of
 * `/health/ready`: a permanent claim there becomes a trap for whoever first
 * boots on a fresh database. It shipped with the cutover so that reverting the
 * cutover would have reverted the guard too — the two were one decision.
 *
 * ## It needs no "the store is legitimately empty" escape hatch
 *
 * The pre-rollout one-shots run before any task takes traffic, and a window that
 * deliberately empties or reloads the store holds the service at desired count
 * 0 while it does — so the only moment the store is legitimately empty is a
 * moment no deploy is running. That dependency on the deploy's ORDER is
 * executable rather than prose: change the order and this is what notices.
 */

import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { logger } from '../utils/logger';

/**
 * One table that cannot legitimately be empty once Postgres is authoritative,
 * with the reason it cannot — the reason is what a later reader needs in order
 * to decide whether a failure is real.
 */
export interface PopulationFloor {
  readonly table: string;
  readonly minimum: number;
  readonly why: string;
}

/**
 * Two tables, not one, and not twenty.
 *
 * One is not enough: the copy walks collections in level order, so it can write
 * `federated_actors` and die before `posts`, and a single-table floor would
 * report a partial copy as a healthy one. Twenty would be a list where any
 * entry that is legitimately empty in some future state becomes a false
 * refusal mid-window — and a false refusal here costs the window.
 *
 * Both counts come from the rehearsed copy of production (2026-08-03).
 */
export const POPULATION_FLOORS: readonly PopulationFloor[] = [
  {
    table: 'posts',
    minimum: 100_000,
    why:
      'The source holds 622,474 posts (counted on production Mongo, 2026-08-04). ' +
      'A floor of 1 was satisfied by 100 rows of smoke-test residue and let a ' +
      'trunk image serve a database with 0.016% of production in it — the check ' +
      'asked "is this literally empty" when the property is "does this hold ' +
      'production". 100,000 is ~6x below the real count, so a legitimately ' +
      'smaller copy still passes, and ~1000x above any plausible residue.',
  },
  {
    table: 'federated_actors',
    minimum: 10_000,
    why:
      'The copy carried 66,258 remote actors. It was written at a DIFFERENT ' +
      'level of that copy than `posts`, which is what makes the pair able to ' +
      'tell a partial restore from an empty database — and federated ingest ' +
      'writes this table continuously, so a fresh or wrong database accrues ' +
      'residue here fastest and it needs the wider margin most. 10,000 is ~6x ' +
      'below the real count and ~500x above the residue observed.',
  },
];

/** What one floor read. */
export interface PopulationReading {
  readonly table: string;
  readonly rows: number;
}

/** The verdict, and the lines an operator reads. */
export interface PopulationVerdict {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/**
 * Decide from the readings alone — separated from the counting so the decision
 * is testable without a database, and so the two failures it distinguishes
 * (below the floor / never measured) cannot be conflated by a query error.
 *
 * Reports what it counted AND what it required, on SUCCESS as well as failure.
 * A check that says only "passed" leaves nobody able to tell afterwards whether
 * it looked at anything — which is how a capped report becomes a claim about a
 * system when it was a claim about a measurement.
 */
export function evaluatePopulation(
  floors: readonly PopulationFloor[],
  readings: readonly PopulationReading[]
): PopulationVerdict {
  const lines: string[] = [];
  let ok = true;

  // A floor with no reading is NOT a pass. Whatever stopped the count from
  // happening left the question unanswered, and an unanswered question about
  // whether production has data must not read as yes.
  if (floors.length === 0) {
    return {
      ok: false,
      lines: ['no population floors are declared, so nothing was checked'],
    };
  }

  for (const floor of floors) {
    const reading = readings.find((entry) => entry.table === floor.table);
    if (reading === undefined) {
      ok = false;
      lines.push(`${floor.table}: NOT MEASURED (floor ${floor.minimum}) — ${floor.why}`);
      continue;
    }
    const verdict = reading.rows >= floor.minimum ? 'ok' : 'BELOW FLOOR';
    if (reading.rows < floor.minimum) ok = false;
    lines.push(
      `${floor.table}: ${reading.rows} row(s), floor ${floor.minimum} — ${verdict}`
    );
  }
  return { ok, lines };
}

/** `count(*)`, read-only. */
async function countRows(table: string): Promise<number> {
  // The table names come from POPULATION_FLOORS, a constant in this file — not
  // from input — so the identifier is interpolated rather than parameterised,
  // which a table name cannot be anyway.
  const rows = await getDb().execute<{ count: string }>(
    sql.raw(`select count(*)::text as count from ${table}`)
  );
  const first = Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0];
  const value = (first as { count?: string } | undefined)?.count;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`count(*) on ${table} returned ${String(value)}, which is not a number`);
  }
  return parsed;
}

async function main(): Promise<number> {
  await connectPostgres();
  const readings: PopulationReading[] = [];
  for (const floor of POPULATION_FLOORS) {
    readings.push({ table: floor.table, rows: await countRows(floor.table) });
  }

  const verdict = evaluatePopulation(POPULATION_FLOORS, readings);
  for (const line of verdict.lines) logger.info(`[assertPostgresPopulated] ${line}`);

  if (!verdict.ok) {
    logger.error(
      '[assertPostgresPopulated] REFUSING THE ROLLOUT. The schema is present and ' +
        'the connection works, so this is not an unreachable database — it is a ' +
        'REACHABLE EMPTY ONE, which every HTTP check in this pipeline reports as ' +
        'healthy. If the copy has not run yet, that is the answer: run it. If it ' +
        'has, something emptied the target and the deploy must not proceed.'
    );
    return 1;
  }
  logger.info('[assertPostgresPopulated] every floor satisfied; the rollout may proceed.');
  return 0;
}

// Guarded so the exported helpers above stay importable by the tests without
// the file counting rows on import.
if (require.main === module) {
  void main()
    .then(async (code) => {
      await closePostgres();
      process.exit(code);
    })
    .catch(async (error) => {
      logger.error('[assertPostgresPopulated] failed', error);
      await closePostgres().catch(() => undefined);
      process.exit(1);
    });
}
