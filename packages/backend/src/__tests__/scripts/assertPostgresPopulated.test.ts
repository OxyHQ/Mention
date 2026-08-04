/**
 * The pre-rollout population floor.
 *
 * The decision is tested apart from the counting on purpose: the failure this
 * guards is "a reachable database with nothing in it", and a test that needed a
 * real empty database could only be written by emptying a shared one. So
 * `evaluatePopulation` takes readings and returns a verdict, and these assert
 * the verdict — including the two failures it must not conflate.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluatePopulation,
  POPULATION_FLOORS,
  type PopulationFloor,
} from '../../scripts/assertPostgresPopulated';

const floors: readonly PopulationFloor[] = [
  { table: 'posts', minimum: 1, why: 'why posts' },
  { table: 'federated_actors', minimum: 1, why: 'why actors' },
];

describe('the pre-rollout population floor', () => {
  it('passes a populated database and SAYS WHAT IT COUNTED', () => {
    const verdict = evaluatePopulation(floors, [
      { table: 'posts', rows: 4_989_522 },
      { table: 'federated_actors', rows: 64_156 },
    ]);
    expect(verdict.ok).toBe(true);
    // On success as well as failure. A check that reports only "passed" cannot
    // be audited afterwards, which is how a measurement becomes a claim.
    expect(verdict.lines).toEqual([
      'posts: 4989522 row(s), floor 1 — ok',
      'federated_actors: 64156 row(s), floor 1 — ok',
    ]);
  });

  it('REFUSES an empty database and names the table that was empty', () => {
    // The 2026-08-04 shape: schema present, connection fine, no rows.
    const verdict = evaluatePopulation(floors, [
      { table: 'posts', rows: 0 },
      { table: 'federated_actors', rows: 0 },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.lines[0]).toContain('posts: 0 row(s), floor 1 — BELOW FLOOR');
    expect(verdict.lines[1]).toContain('federated_actors: 0 row(s), floor 1 — BELOW FLOOR');
  });

  it('REFUSES a PARTIAL copy, which one table alone would report as healthy', () => {
    // The copy walks collections in level order, so it can write actors and die
    // before posts. This is the case the second floor exists for — with only
    // `federated_actors` declared, this reading passes.
    const verdict = evaluatePopulation(floors, [
      { table: 'posts', rows: 0 },
      { table: 'federated_actors', rows: 64_156 },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.lines[0]).toContain('BELOW FLOOR');
    expect(verdict.lines[1]).toContain('ok');
  });

  it('treats a floor that was NEVER MEASURED as a refusal, not a pass', () => {
    // Whatever stopped the count left the question unanswered, and an
    // unanswered question about whether production has data must not read as
    // yes. Distinguished from BELOW FLOOR because they send an operator to
    // different places.
    const verdict = evaluatePopulation(floors, [{ table: 'posts', rows: 4_989_522 }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.lines[1]).toContain('federated_actors: NOT MEASURED');
    expect(verdict.lines[1]).not.toContain('BELOW FLOOR');
  });

  it('refuses when NO floors are declared, rather than passing vacuously', () => {
    const verdict = evaluatePopulation([], []);
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.join(' ')).toContain('nothing was checked');
  });

  it('declares at least two tables, written at DIFFERENT levels of the copy', () => {
    // The vacuity floor on the floor: one table cannot tell a partial copy from
    // an empty one, and a list that shrank to one would still pass every
    // assertion above.
    expect(POPULATION_FLOORS.length).toBeGreaterThanOrEqual(2);
    for (const floor of POPULATION_FLOORS) {
      expect(floor.why.length).toBeGreaterThan(40);
    }
  });

  it('sets every floor far above RESIDUE, not merely above zero', () => {
    // This assertion previously read `toBeGreaterThanOrEqual(1)`, and a floor of
    // 1 is what shipped. It did not hold: on 2026-08-04 the deploy ran this
    // check against a Postgres carrying 100 posts and 19 federated actors of
    // smoke-test and federated-ingest residue, reported `completed
    // successfully`, and let a trunk image serve 0.016% of production.
    //
    // "Above zero" and "holds production" are different questions, and only the
    // second one is worth a deploy gate. Residue is not hypothetical here:
    // federated ingest writes `federated_actors` continuously while the site
    // still serves Mongo, so the number it accrues only ever grows.
    const OBSERVED_RESIDUE_HIGH_WATER = 100;
    for (const floor of POPULATION_FLOORS) {
      expect(floor.minimum).toBeGreaterThan(OBSERVED_RESIDUE_HIGH_WATER * 10);
    }
  });
});
