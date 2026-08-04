import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

/**
 * The resume-cursor store shared by every long-running administrative sweep.
 *
 * These scripts only ever run as one-shot Fargate tasks, so a cursor on the
 * container filesystem dies with the task, and CloudWatch cannot hold one either
 * — the backend logger rewrites every 24-hex ObjectId to `[REDACTED]` and
 * redacts any key ending in `id` (covered by
 * `__tests__/utils/loggerSanitization.test.ts`). The database is the only
 * durable place a sweep already has, so what is pinned here is the
 * read/write/clear contract every sweep depends on to be resumable at all.
 *
 * Against REAL `admin_script_cursors` rows. The mocked model that used to stand
 * in for them asserted the SHAPE of a Mongo update document, which after the
 * port describes nothing that runs — and could not have caught the one property
 * that actually matters here (a completion stamp being CLEARED when the scope
 * gains work) because a mock cannot forget a value it was never storing.
 */

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { adminScriptCursors } from '../../db/schema/adminScripts';
import {
  clearAdminScriptCursor,
  readAdminScriptCursor,
  recordAdminScriptCursor,
} from '../../scripts/lib/adminScriptCursor';
import { logger } from '../../utils/logger';

/** Per-file namespace — vitest runs files in parallel against one database. */
const SCRIPT = 'adminScriptCursorTest:repairFederatedMentions';
const SCOPE = 'after:|before:|actor:';
const CURSOR = '65fdc8c8c8c8c8c8c8c8c8c8';

beforeAll(async () => {
  await connectPostgres();
}, 60_000);

afterEach(async () => {
  await getDb().delete(adminScriptCursors).where(eq(adminScriptCursors.script, SCRIPT));
  vi.mocked(logger.warn).mockClear();
});

afterAll(async () => {
  await closePostgres();
});

/** The stored row for this file's scope, or `undefined`. */
async function storedRow() {
  const [row] = await getDb()
    .select()
    .from(adminScriptCursors)
    .where(and(eq(adminScriptCursors.script, SCRIPT), eq(adminScriptCursors.scope, SCOPE)));
  return row;
}

describe('readAdminScriptCursor', () => {
  it('returns null for a scope that has never run', async () => {
    await expect(readAdminScriptCursor(SCRIPT, SCOPE)).resolves.toBeNull();
  });

  it('reports where the scope got to, and whether it finished', async () => {
    await recordAdminScriptCursor(SCRIPT, SCOPE, {
      cursor: CURSOR,
      scanned: 30_000,
      completed: true,
    });

    const state = await readAdminScriptCursor(SCRIPT, SCOPE);
    expect(state?.cursor).toBe(CURSOR);
    expect(state?.scanned).toBe(30_000);
    expect(state?.completedAt).toBeInstanceOf(Date);
  });

  it('reports an unfinished scope as "not known to have finished"', async () => {
    await recordAdminScriptCursor(SCRIPT, SCOPE, { cursor: CURSOR, scanned: 1 });

    // NULL, and it must stay NULL. An invented value fails toward SILENCE — a
    // destructive purge quietly never re-run — while a missing one fails toward
    // WORK. Only the second is recoverable.
    await expect(readAdminScriptCursor(SCRIPT, SCOPE)).resolves.toMatchObject({
      completedAt: null,
    });
  });

  it('accepts a cursor that is not an ObjectId', async () => {
    // Every row written after the cutover has a uuid v7 primary key, and a sweep
    // resuming through this store has to be able to hold one. A shape guard
    // anywhere on this path answers "never ran" for all of them — silently,
    // forever — which is exactly what `purgeBlockedDomainContent`'s
    // `isValidObjectId` check would have started doing.
    const uuid = '01924f3c-0000-7000-8000-0123456789ab';
    await recordAdminScriptCursor(SCRIPT, SCOPE, { cursor: uuid, scanned: 7 });

    await expect(readAdminScriptCursor(SCRIPT, SCOPE)).resolves.toMatchObject({
      cursor: uuid,
      scanned: 7,
    });
  });
});

describe('recordAdminScriptCursor', () => {
  it('upserts the scope\'s progress and reports that the write landed', async () => {
    await expect(
      recordAdminScriptCursor(SCRIPT, SCOPE, { cursor: CURSOR, scanned: 500 }),
    ).resolves.toBe(true);

    const row = await storedRow();
    expect(row?.cursor).toBe(CURSOR);
    expect(row?.scanned).toBe(500);
    expect(row?.completedAt).toBeNull();
  });

  it('stamps a completion time only when the range was exhausted', async () => {
    await recordAdminScriptCursor(SCRIPT, SCOPE, {
      cursor: CURSOR,
      scanned: 500,
      completed: true,
    });

    expect((await storedRow())?.completedAt).toBeInstanceOf(Date);
  });

  it('clears an earlier completion stamp when the scope has more work', async () => {
    // A scope that gained new candidates after finishing must not keep reading
    // as finished, or the next operator sees "nothing to do" and believes it.
    // This is the case the mocked version could not observe: it asserted the
    // update document SAID `completedAt: null`, never that a real stamp went.
    await recordAdminScriptCursor(SCRIPT, SCOPE, {
      cursor: CURSOR,
      scanned: 500,
      completed: true,
    });
    expect((await storedRow())?.completedAt).toBeInstanceOf(Date);

    await recordAdminScriptCursor(SCRIPT, SCOPE, { cursor: CURSOR, scanned: 900 });

    const row = await storedRow();
    expect(row?.completedAt).toBeNull();
    expect(row?.scanned).toBe(900);
  });

  it('keeps one row per (script, scope) however often it is written', async () => {
    await recordAdminScriptCursor(SCRIPT, SCOPE, { cursor: CURSOR, scanned: 1 });
    await recordAdminScriptCursor(SCRIPT, SCOPE, { cursor: CURSOR, scanned: 2 });
    await recordAdminScriptCursor(SCRIPT, `${SCOPE}|other`, { cursor: CURSOR, scanned: 3 });

    const rows = await getDb()
      .select()
      .from(adminScriptCursors)
      .where(eq(adminScriptCursors.script, SCRIPT));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.scope === SCOPE)?.scanned).toBe(2);
  });

  it('reports a failed write instead of throwing, and never logs the cursor', async () => {
    // A transient blip must not kill a sweep that is otherwise doing its work
    // correctly; the caller counts the miss and fails the run at the end. The
    // refusal comes from the database's own CHECK on `scanned`, so the failure
    // path is exercised by a real rejection rather than by a stub told to throw.
    await expect(
      recordAdminScriptCursor(SCRIPT, SCOPE, { cursor: CURSOR, scanned: -1 }),
    ).resolves.toBe(false);

    const [message, context] = vi.mocked(logger.warn).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toContain('could not persist the resume cursor');
    expect(JSON.stringify(context)).not.toContain(CURSOR);
  });
});

describe('clearAdminScriptCursor', () => {
  it('forgets the scope\'s progress', async () => {
    await recordAdminScriptCursor(SCRIPT, SCOPE, { cursor: CURSOR, scanned: 5 });

    await clearAdminScriptCursor(SCRIPT, SCOPE);

    await expect(readAdminScriptCursor(SCRIPT, SCOPE)).resolves.toBeNull();
  });

  it('leaves another scope of the same script alone', async () => {
    await recordAdminScriptCursor(SCRIPT, SCOPE, { cursor: CURSOR, scanned: 5 });
    await recordAdminScriptCursor(SCRIPT, `${SCOPE}|other`, { cursor: CURSOR, scanned: 6 });

    await clearAdminScriptCursor(SCRIPT, SCOPE);

    await expect(readAdminScriptCursor(SCRIPT, `${SCOPE}|other`)).resolves.toMatchObject({
      scanned: 6,
    });
  });
});
