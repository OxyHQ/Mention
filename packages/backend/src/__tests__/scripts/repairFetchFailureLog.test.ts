import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';

/**
 * The per-post re-fetch failure log.
 *
 * It exists because a sweep's candidate filter cannot select the RETRYABLE tail:
 * measured on the real corpus, 5,691 transient failures sat inside 46,291
 * candidates, so retrying them through the filter meant ~40,600 requests to
 * other people's servers that could not produce a repair. What is pinned here is
 * the write contract that makes the targeted alternative possible — and the
 * never-throw policy, since a bookkeeping blip must not kill a six-hour sweep.
 *
 * Against REAL `repair_fetch_failures` rows. The mocked model asserted the shape
 * of a `bulkWrite` operation list, which after the port describes nothing that
 * runs; more importantly it could not observe the property the whole targeting
 * scheme rests on — that `status` stays ABSENT when the transport never saw one.
 * A defaulted status is not erasure, it is RELOCATION: it moves a row from "do
 * not come back" (403/410) into "retry politely" (429/5xx), and the retry then
 * hammers an origin that already refused.
 */

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { repairFetchFailures } from '../../db/schema/adminScripts';
import { recordRepairFetchFailures } from '../../scripts/lib/repairFetchFailureLog';
import { logger } from '../../utils/logger';

/** Per-file namespace — vitest runs files in parallel against one database. */
const SCRIPT = 'repairFetchFailureLogTest:repairFederatedMentions';
const POST_ID = '65fdc8c8c8c8c8c8c8c8c8c8';
const OTHER_POST_ID = '65fdc8c8c8c8c8c8c8c8c8c9';

beforeAll(async () => {
  await connectPostgres();
}, 60_000);

afterEach(async () => {
  await getDb().delete(repairFetchFailures).where(eq(repairFetchFailures.script, SCRIPT));
  vi.mocked(logger.warn).mockClear();
});

afterAll(async () => {
  await closePostgres();
});

/** This file's rows, oldest post id first. */
async function storedRows() {
  return getDb()
    .select()
    .from(repairFetchFailures)
    .where(eq(repairFetchFailures.script, SCRIPT))
    .orderBy(asc(repairFetchFailures.postId));
}

describe('recordRepairFetchFailures', () => {
  it('writes one row per post, keyed on script and post', async () => {
    await expect(
      recordRepairFetchFailures(SCRIPT, [{ postId: POST_ID, reason: 'httpStatus', status: 429 }]),
    ).resolves.toBe(true);

    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].postId).toBe(POST_ID);
    expect(rows[0].reason).toBe('httpStatus');
    expect(rows[0].status).toBe(429);
    expect(rows[0].failedAt).toBeInstanceOf(Date);
  });

  it('keeps a missing status NULL rather than defaulting it', async () => {
    // The discriminating case. A timeout genuinely has no status, and the
    // targeting query splits "retry politely" from "do not come back" on exactly
    // this column — so an invented value silently moves a row between the two.
    await recordRepairFetchFailures(SCRIPT, [{ postId: POST_ID, reason: 'timeout' }]);

    expect((await storedRows())[0].status).toBeNull();
  });

  it('replaces a status with NULL when the post fails a second time without one', async () => {
    // Not a coalesce: a post that failed with a 403 and now times out really has
    // no status, and carrying the old one forward would say the origin refused
    // again when it never answered.
    await recordRepairFetchFailures(SCRIPT, [
      { postId: POST_ID, reason: 'httpStatus', status: 403 },
    ]);
    await recordRepairFetchFailures(SCRIPT, [{ postId: POST_ID, reason: 'timeout' }]);

    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('timeout');
    expect(rows[0].status).toBeNull();
  });

  it('stays bounded by DISTINCT failing posts however many times the sweep runs', async () => {
    await recordRepairFetchFailures(SCRIPT, [{ postId: POST_ID, reason: 'transport' }]);
    await recordRepairFetchFailures(SCRIPT, [{ postId: POST_ID, reason: 'timeout' }]);
    await recordRepairFetchFailures(SCRIPT, [{ postId: OTHER_POST_ID, reason: 'timeout' }]);

    const rows = await storedRows();
    expect(rows).toHaveLength(2);
    // The refreshed row carries the LATEST reason, not the first.
    expect(rows.find((row) => row.postId === POST_ID)?.reason).toBe('timeout');
  });

  it('writes nothing when there is nothing to write', async () => {
    await expect(recordRepairFetchFailures(SCRIPT, [])).resolves.toBe(true);

    // An empty `VALUES` list is a syntax error, so this has to stay a guard.
    expect(await storedRows()).toEqual([]);
  });

  it('stamps one timestamp across the batch', async () => {
    await recordRepairFetchFailures(SCRIPT, [
      { postId: POST_ID, reason: 'transport' },
      { postId: OTHER_POST_ID, reason: 'timeout' },
    ]);

    const rows = await storedRows();
    expect(rows[0].failedAt.getTime()).toBe(rows[1].failedAt.getTime());
  });

  it('reports a failed write instead of throwing, and never logs a post id', async () => {
    // A blip must not kill a sweep that is otherwise repairing posts correctly;
    // the caller counts the miss and fails the run at the end. The refusal is a
    // real one — the CHECK bounding `status` to a plausible HTTP code — rather
    // than a stub told to reject.
    await expect(
      recordRepairFetchFailures(SCRIPT, [
        { postId: POST_ID, reason: 'httpStatus', status: 99 },
      ]),
    ).resolves.toBe(false);

    const [message, context] = vi.mocked(logger.warn).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toContain('could not record re-fetch failures');
    expect(context.count).toBe(1);
    expect(JSON.stringify(context)).not.toContain(POST_ID);
    expect(await storedRows()).toEqual([]);
  });
});
