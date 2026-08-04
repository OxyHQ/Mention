/**
 * `services/safety/viewerSafety` — the ONE read path for the two per-viewer
 * safety preferences, against real rows.
 *
 * Both loaders soft-fail toward the SAFE default, and that is the property worth
 * pinning: an unreachable database must mean "do not show sensitive content" and
 * "no mutes", never a broken feed, a broken search or a broken notification
 * list. A test that only asserted the happy path would pass against a loader
 * that threw on every failure.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { muteWords } from '../../db/schema/engagement';
import { userSettings } from '../../db/schema/userProfile';
import { loadMuteWords, loadShowSensitiveContent } from '../../services/safety/viewerSafety';

let db: Database;
const createdUserIds: string[] = [];

function viewerId(): string {
  const id = `oxy-safety-${randomUUID()}`;
  createdUserIds.push(id);
  return id;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(muteWords).where(inArray(muteWords.userId, createdUserIds));
    await db.delete(userSettings).where(inArray(userSettings.oxyUserId, createdUserIds));
    createdUserIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('loadShowSensitiveContent', () => {
  it('is false for an anonymous viewer and for one with no settings row', async () => {
    expect(await loadShowSensitiveContent(undefined)).toBe(false);
    expect(await loadShowSensitiveContent(viewerId())).toBe(false);
  });

  it('is false for a settings row that never touched the flag', async () => {
    // The column is `NOT NULL DEFAULT false`, so "has settings" and "opted in"
    // are different facts and the loader must not conflate them.
    const viewer = viewerId();
    await db.insert(userSettings).values({ oxyUserId: viewer });
    expect(await loadShowSensitiveContent(viewer)).toBe(false);
  });

  it('is true only for an explicit stored opt-in', async () => {
    const viewer = viewerId();
    await db.insert(userSettings).values({ oxyUserId: viewer, privacyShowSensitiveContent: true });
    expect(await loadShowSensitiveContent(viewer)).toBe(true);
  });

  it('reads one viewer’s flag, never another’s', async () => {
    const optedIn = viewerId();
    const optedOut = viewerId();
    await db.insert(userSettings).values([
      { oxyUserId: optedIn, privacyShowSensitiveContent: true },
      { oxyUserId: optedOut, privacyShowSensitiveContent: false },
    ]);
    expect(await loadShowSensitiveContent(optedIn)).toBe(true);
    expect(await loadShowSensitiveContent(optedOut)).toBe(false);
  });
});

describe('loadMuteWords', () => {
  it('is empty for an anonymous viewer and for one with no rules', async () => {
    expect(await loadMuteWords(undefined)).toEqual([]);
    expect(await loadMuteWords(viewerId())).toEqual([]);
  });

  it('returns exactly the fields the matcher reads', async () => {
    const viewer = viewerId();
    await db.insert(muteWords).values([
      { userId: viewer, value: 'spoilers', targets: ['content', 'tag'] },
      {
        userId: viewer,
        value: 'politics',
        targets: ['tag'],
        actorTarget: 'exclude-following',
      },
    ]);

    const rules = await loadMuteWords(viewer);
    expect([...rules].sort((a, b) => a.value.localeCompare(b.value))).toEqual([
      { value: 'politics', targets: ['tag'], actorTarget: 'exclude-following' },
      { value: 'spoilers', targets: ['content', 'tag'], actorTarget: 'all' },
    ]);
  });

  it('defaults actorTarget to `all` at the COLUMN, not in the reader', async () => {
    // The row is written without the field; the `NOT NULL DEFAULT 'all'` is what
    // makes a rule written before the field existed still apply to every author.
    const viewer = viewerId();
    await db.insert(muteWords).values({ userId: viewer, value: 'x', targets: ['content'] });
    const [rule] = await loadMuteWords(viewer);
    expect(rule.actorTarget).toBe('all');
  });

  it('reads one viewer’s rules, never another’s', async () => {
    const viewer = viewerId();
    const stranger = viewerId();
    await db.insert(muteWords).values([
      { userId: viewer, value: 'mine', targets: ['content'] },
      { userId: stranger, value: 'theirs', targets: ['content'] },
    ]);

    expect((await loadMuteWords(viewer)).map((rule) => rule.value)).toEqual(['mine']);
  });
});

describe('soft-failure toward the safe default', () => {
  it('answers false / [] when the database is unreachable, and never throws', async () => {
    /**
     * The pool is closed for the duration of this case, so `getDb()` throws
     * exactly as it would during a startup or connectivity failure. Both loaders
     * must swallow it: a feed, a search and a notification list all call these
     * on the request path, and an exception here would take the whole response
     * down rather than degrading to the conservative answer.
     */
    const viewer = viewerId();
    await closePostgres();
    try {
      await expect(loadShowSensitiveContent(viewer)).resolves.toBe(false);
      await expect(loadMuteWords(viewer)).resolves.toEqual([]);
    } finally {
      db = await connectPostgres();
    }

    // And the pool really is usable again — otherwise every later case in this
    // file would be passing for the wrong reason.
    expect(await loadShowSensitiveContent(viewer)).toBe(false);
  });
});
