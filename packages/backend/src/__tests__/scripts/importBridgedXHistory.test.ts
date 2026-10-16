import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The bridged X history import, against real rows.
 *
 * What a reviewer has to believe before it runs against production:
 *
 *  1. **The committed fixture is valid** — every entry parses, and a duplicate
 *     or a malformed id is rejected rather than imported.
 *  2. **A dry run imports nothing** — it reads which items are held and stops.
 *  3. **Each item goes through the ingest path, never a write of its own** — a
 *     post through `ensureQuotedNote` at its bridge status URI, a retweet through
 *     `importAnnounce` with the ORIGINAL's bridge URI and a stable minted id.
 *  4. **It is idempotent** — an item already held is not fetched again.
 *  5. **A flaky bridge is retried, and what still fails is reported** rather
 *     than counted as imported.
 *
 * The bridge and Oxy are not reached: `ensureQuotedNote`, `importAnnounce` and
 * the booster's resolution are spied on. The held-item lookup is REAL, because
 * it is the idempotency.
 */

import { connectPostgres, closePostgres } from '../../db/postgres';
import { outboxSyncService } from '../../connectors/activitypub/outbox.service';
import { actorService } from '../../connectors/activitypub/actor.service';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import {
  X_HISTORY_FIXTURES,
  bridgeStatusUri,
  importBridgedXHistory,
  repostActivityId,
  xHistoryFixtureSchema,
  type XHistoryFixture,
} from '../../scripts/importBridgedXHistory';

const scope = serviceScope('import-bridged-x-history');
const BOOSTER = scope.user('booster');

let seq = 0;
/** A handle no other test has used, so status URIs never collide across tests. */
function nextHandle(): string {
  seq += 1;
  return `xhist${seq}${Date.now() % 100000}`;
}

function fixture(handle: string, items: XHistoryFixture['items']): XHistoryFixture {
  return xHistoryFixtureSchema.parse({ handle, source: 'test', items });
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

function spyIngest() {
  return {
    note: vi.spyOn(outboxSyncService, 'ensureQuotedNote').mockResolvedValue('post-id'),
    announce: vi.spyOn(outboxSyncService, 'importAnnounce').mockResolvedValue(true),
    booster: vi.spyOn(actorService, 'resolveActorOxyUserId').mockResolvedValue(BOOSTER),
  };
}

describe('the committed fixtures', () => {
  it('parses every committed account', () => {
    for (const [account, raw] of Object.entries(X_HISTORY_FIXTURES)) {
      const parsed = xHistoryFixtureSchema.parse(raw);
      expect(parsed.handle.toLowerCase()).toBe(account);
      expect(parsed.items.length).toBeGreaterThan(0);
    }
  });

  it('rejects a duplicate item and a malformed id', () => {
    const post = { kind: 'post', id: '1245870767151038464' } as const;
    expect(() => fixture('enricdurang', [post, post])).toThrow(/duplicate/);
    expect(() => fixture('enricdurang', [{ kind: 'post', id: '12a' }])).toThrow();
  });
});

describe('importBridgedXHistory', () => {
  it('imports nothing on a dry run', async () => {
    const spies = spyIngest();
    const result = await importBridgedXHistory(fixture(nextHandle(), [{ kind: 'post', id: '1' }]), {
      dryRun: true,
    });
    expect(result).toMatchObject({ items: 1, alreadyHeld: 0, imported: 0, failed: 0 });
    expect(spies.note).not.toHaveBeenCalled();
    expect(spies.announce).not.toHaveBeenCalled();
  });

  it('imports a post at its bridge URI and a retweet as a boost of the original', async () => {
    const spies = spyIngest();
    const handle = nextHandle();
    const result = await importBridgedXHistory(
      fixture(handle, [
        { kind: 'post', id: '10' },
        { kind: 'repost', id: '20', author: 'Free_Ross', publishedAt: '2022-03-27T13:38:35Z' },
      ]),
      { dryRun: false, retryDelayMs: 0 },
    );

    expect(result).toMatchObject({ posts: 1, reposts: 1, imported: 2, failed: 0 });
    expect(spies.note).toHaveBeenCalledWith(`https://bird.makeup/users/${handle}/statuses/10`);
    expect(spies.booster).toHaveBeenCalledWith(`https://bird.makeup/users/${handle}`);
    expect(spies.announce).toHaveBeenCalledWith(
      {
        id: repostActivityId(handle, '20'),
        type: 'Announce',
        actor: `https://bird.makeup/users/${handle}`,
        published: '2022-03-27T13:38:35Z',
        url: 'https://x.com/Free_Ross/status/20',
      },
      'https://bird.makeup/users/free_ross/statuses/20',
      BOOSTER,
    );
  });

  it('does not fetch an item it already holds', async () => {
    const spies = spyIngest();
    const handle = nextHandle();
    await seedPost(scope, { federation: { activityId: bridgeStatusUri(handle, '30') } });
    await seedPost(scope, { federation: { activityId: repostActivityId(handle, '40') } });

    const result = await importBridgedXHistory(
      fixture(handle, [
        { kind: 'post', id: '30' },
        { kind: 'repost', id: '40', author: 'someone', publishedAt: '2020-01-01T00:00:00Z' },
        { kind: 'post', id: '31' },
      ]),
      { dryRun: false, retryDelayMs: 0 },
    );

    expect(result).toMatchObject({ items: 3, alreadyHeld: 2, imported: 1 });
    expect(spies.note).toHaveBeenCalledTimes(1);
    expect(spies.note).toHaveBeenCalledWith(bridgeStatusUri(handle, '31'));
    expect(spies.announce).not.toHaveBeenCalled();
  });

  it('retries a status the bridge failed once, and reports one that keeps failing', async () => {
    const spies = spyIngest();
    const handle = nextHandle();
    spies.note.mockImplementation(async (uri: string) => {
      if (uri.endsWith('/51')) return null;
      return spies.note.mock.calls.filter(([u]) => u === uri).length > 1 ? 'post-id' : null;
    });

    const result = await importBridgedXHistory(
      fixture(handle, [
        { kind: 'post', id: '50' },
        { kind: 'post', id: '51' },
      ]),
      { dryRun: false, retryDelayMs: 0 },
    );

    expect(result).toMatchObject({ imported: 1, failed: 1, failedItems: ['post:51'] });
    expect(spies.note.mock.calls.filter(([u]) => u.endsWith('/51'))).toHaveLength(3);
  });
});
