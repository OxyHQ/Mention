/**
 * The guard on the most dangerous step in the migration.
 *
 * The copy writes ~5,000,000 rows into whatever `DATABASE_URL` names, and until
 * this existed nothing checked WHICH database that was — the runbook said "read
 * the registered JSON back before running it", which is a procedure standing
 * where a mechanism belongs.
 *
 * Both halves are pinned, because they fail at different moments and for
 * different reasons: the flag checks happen before a socket is opened, and the
 * identity check happens against a live connection.
 *
 * Fixtures are `btd-` prefixed. Nothing here writes a row.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  assertTargetDatabase,
  assertTargetDeclared,
  MissingTargetDatabaseError,
  UnconfirmedTruncateError,
  WrongTargetDatabaseError,
} from '../../db/backfill/targetDatabase';
import { sql } from 'drizzle-orm';

/** The database the test harness actually connected to. */
let connectedDatabase: string;

beforeAll(async () => {
  await connectPostgres();
  const rows = await getDb().execute<{ current_database: string }>(sql`select current_database()`);
  const name = rows[0]?.current_database;
  if (name === undefined) throw new Error('could not read current_database()');
  connectedDatabase = name;
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

describe('assertTargetDeclared — the flags, before anything connects', () => {
  it('refuses a run that did not name its target', () => {
    // Not a default, not a warning. A run that does not state where it believes
    // it is pointing cannot be checked against where it IS pointing, which is
    // the entire failure being prevented.
    expect(() =>
      assertTargetDeclared({
        targetDatabase: undefined,
        startFromEmpty: false,
        confirmTruncate: undefined,
      })
    ).toThrow(MissingTargetDatabaseError);
  });

  it('refuses a target that is only whitespace', () => {
    // `--target-database=` parses to an empty string rather than `undefined`,
    // so the emptiness check has to survive the shell as well as the absence.
    expect(() =>
      assertTargetDeclared({ targetDatabase: '   ', startFromEmpty: false, confirmTruncate: undefined })
    ).toThrow(MissingTargetDatabaseError);
  });

  it('accepts a named target and returns it trimmed', () => {
    // The healthy case, beside the refusals: a guard that rejected everything
    // would pass every test above and block every real run.
    expect(
      assertTargetDeclared({
        targetDatabase: ' btd-target ',
        startFromEmpty: false,
        confirmTruncate: undefined,
      })
    ).toBe('btd-target');
  });

  it('refuses --start-from-empty with no confirmation', () => {
    expect(() =>
      assertTargetDeclared({
        targetDatabase: 'btd-target',
        startFromEmpty: true,
        confirmTruncate: undefined,
      })
    ).toThrow(UnconfirmedTruncateError);
  });

  it('refuses --start-from-empty confirmed against a DIFFERENT database', () => {
    // The case a bare "did you confirm?" boolean would let through: the
    // confirmation has to repeat the target, or it carries from one invocation
    // to the next through shell history and confirms the wrong thing.
    expect(() =>
      assertTargetDeclared({
        targetDatabase: 'btd-target',
        startFromEmpty: true,
        confirmTruncate: 'btd-somewhere-else',
      })
    ).toThrow(UnconfirmedTruncateError);
  });

  it('allows --start-from-empty confirmed against the named target', () => {
    expect(
      assertTargetDeclared({
        targetDatabase: 'btd-target',
        startFromEmpty: true,
        confirmTruncate: 'btd-target',
      })
    ).toBe('btd-target');
  });
});

describe('assertTargetDatabase — the named target against the live connection', () => {
  it('passes when the connected database is the one named', async () => {
    await expect(assertTargetDatabase(getDb(), connectedDatabase)).resolves.toBeUndefined();
  });

  it('refuses when they differ', async () => {
    await expect(assertTargetDatabase(getDb(), 'btd-not-the-connected-database')).rejects.toThrow(
      WrongTargetDatabaseError
    );
  });

  it('names BOTH sides, because either end can be the wrong one', async () => {
    // "Wrong database" tells an operator they are wrong. Naming both tells them
    // WHICH of the flag and the secret to fix, at 3am, on the one step that
    // cannot be undone by re-running it.
    const failure = await assertTargetDatabase(getDb(), 'btd-not-the-connected-database').catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(WrongTargetDatabaseError);
    expect(String(failure)).toContain('btd-not-the-connected-database');
    expect(String(failure)).toContain(connectedDatabase);
  });

  it('says plainly that nothing was read or written', async () => {
    // The first question on seeing this at 3am is "did it do anything before it
    // stopped". The answer has to be in the error, not in someone's reading of
    // the call order.
    await expect(assertTargetDatabase(getDb(), 'btd-not-the-connected-database')).rejects.toThrow(
      /nothing has been read and nothing has been written/i
    );
  });
});
