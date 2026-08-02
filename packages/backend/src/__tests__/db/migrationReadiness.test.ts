/**
 * The boot gate: a task must refuse to serve when the database is behind the
 * migrations shipped in its image.
 *
 * Everything here runs against the REAL ledger table in the real test database —
 * `readLastAppliedMillis` issues an actual `to_regclass` + `select` — because the
 * thing being checked is a comparison between a file on disk and rows in
 * Postgres, and a mocked half of that comparison would only ever prove the
 * comparison agrees with itself.
 *
 * The behind-ledger state is staged from the JOURNAL side rather than by
 * deleting ledger rows. Both express the same relation ("the image ships a
 * migration this database has not applied"), and only one of them is safe:
 * `drizzle.__drizzle_migrations` is shared by every test file in a parallel run,
 * so a file that truncated it would break the other 405 rather than test this
 * one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, getPostgresClient } from '../../db/postgres';
import {
  assertPostgresMigrationsCurrent,
  readJournal,
  type JournalEntry,
} from '../../db/migrationLedger';

/** The tag a staged-behind entry carries — named so a failure message is legible. */
const UNAPPLIED_TAG = '9999_migration_this_database_has_never_seen';

/**
 * The shipped journal plus one entry no ledger row can match.
 *
 * `when` is the newest real entry + 1 rather than a fixed far-future constant:
 * `pendingEntries` compares against the newest RECORDED timestamp, so the entry
 * only has to out-rank what this database has actually applied. Deriving it means
 * the fixture cannot rot when a new migration lands.
 */
function journalStagedAhead(): JournalEntry[] {
  const entries = readJournal();
  const newest = Math.max(...entries.map((entry) => entry.when));
  return [...entries, { tag: UNAPPLIED_TAG, when: newest + 1 }];
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('the Postgres migration boot gate', () => {
  it('lets a task boot when the ledger has every migration in the image', async () => {
    // The positive case, and the one that keeps the gate honest: the test
    // database IS fully migrated, so a gate that refused everything would fail
    // here rather than pass silently on the negative cases below.
    await expect(assertPostgresMigrationsCurrent(getPostgresClient())).resolves.toBeUndefined();
  });

  it('refuses when the image ships a migration the ledger has not recorded', async () => {
    await expect(
      assertPostgresMigrationsCurrent(getPostgresClient(), journalStagedAhead())
    ).rejects.toThrow(/not current/);
  });

  it('names the migrations that are missing, not just that some are', async () => {
    // The message is the whole operational value of the refusal: it is read by
    // someone holding a frozen deploy, and "which ones" is what tells them
    // whether the one-shot never ran or died partway through.
    await expect(
      assertPostgresMigrationsCurrent(getPostgresClient(), journalStagedAhead())
    ).rejects.toThrow(UNAPPLIED_TAG);
  });
});
