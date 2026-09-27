/**
 * Deleting re-hosted federated media from Oxy — against REAL rows.
 *
 * A post deleted at its source must not live on as a re-hosted file, but Oxy
 * stores one file per content hash, so a file id can be SHARED by another post,
 * a variant or a federated banner — and an import can be about to insert a post
 * with that very id. This drives the real outbox, reference check, tombstone
 * and drain; only the Oxy HTTP call is mocked.
 *
 * The drain sweeps the WHOLE outbox, so this file runs against its own database
 * (`isolatedDatabaseFiles.ts`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ deleteFederatedMedia: vi.fn() }));

vi.mock('../../services/mediaCache/oxyMediaStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/mediaCache/oxyMediaStore')>()),
  deleteFederatedMedia: h.deleteFederatedMedia,
}));

import { eq, inArray, sql } from 'drizzle-orm';
import { PostType, PostVisibility, type MediaItem } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { federatedMediaDeletions } from '../../db/schema/federation';
import { userSettings } from '../../db/schema/userProfile';
import { deletePostRecord, insertPostRecord } from '../../db/posts/postRepository';
import {
  FederatedMediaGoneError,
  recordFederatedPoster,
  reviveFederatedFiles,
  tombstoneUnreferenced,
} from '../../db/federation/mediaDeletionRepository';
import { drainFederatedMediaDeletions, mediaDeletionBackoffMs } from '../../services/mediaCache/federatedMediaDeletion';
import { OxyMediaStoreRequestError, OxyMediaStoreThrottledError } from '../../services/mediaCache/oxyMediaStore';

const OWNER = 'oxy-fedmedia-owner';
let seq = 0;
const fileId = () => `fedmedia-file-${(seq += 1)}`;

function rehosted(id: string, type: MediaItem['type'] = 'image'): MediaItem {
  return { id, type, remoteUrl: `https://cdn.example/${id}.jpg`, cachedFromFederation: true };
}

async function federatedPost(media: MediaItem[]): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: OWNER,
    authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
    type: PostType.IMAGE,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'post', tag: 'en' }], media },
    federation: { activityId: `https://remote.example/statuses/${(seq += 1)}`, actorUri: 'https://remote.example/users/a' },
  });
  return record.id;
}

async function stateOf(id: string): Promise<string | undefined> {
  const [row] = await getDb().select({ state: federatedMediaDeletions.state }).from(federatedMediaDeletions).where(eq(federatedMediaDeletions.oxyFileId, id));
  return row?.state;
}

/** Oxy answers `deleted` for every id it is asked about. */
function oxyDeletesEverything() {
  h.deleteFederatedMedia.mockImplementation(async (ids: string[]) => ids.map((id) => ({ id, result: 'deleted' })));
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  h.deleteFederatedMedia.mockReset();
  oxyDeletesEverything();
});

afterAll(async () => {
  await closePostgres();
});

describe('deleting a federated post deletes its re-hosted media', () => {
  it('queues the file in the delete transaction and deletes it from Oxy', async () => {
    const x = fileId();
    const post = await federatedPost([rehosted(x)]);
    await deletePostRecord(post, undefined);
    expect(await stateOf(x)).toBe('pending');

    await drainFederatedMediaDeletions();

    expect(h.deleteFederatedMedia).toHaveBeenCalledWith([x]);
    expect(await stateOf(x)).toBe('deleted');
  });

  it('never queues media Mention did not re-host (a local upload)', async () => {
    const local = fileId();
    const post = await federatedPost([{ id: local, type: 'image' }]);
    await deletePostRecord(post, undefined);
    expect(await stateOf(local)).toBeUndefined();
  });

  it('deletes the video\'s poster frame too, once the video is gone', async () => {
    const video = fileId();
    const poster = fileId();
    await recordFederatedPoster(video, poster);
    const post = await federatedPost([rehosted(video, 'video')]);
    await deletePostRecord(post, undefined);

    // The video's batch queues its poster; the same run's next batch deletes it.
    await drainFederatedMediaDeletions();
    expect(await stateOf(video)).toBe('deleted');
    expect(await stateOf(poster)).toBe('deleted');
    const calls = h.deleteFederatedMedia.mock.calls.map(([ids]) => ids as string[]);
    expect(calls.findIndex((ids) => ids.includes(video))).toBeLessThan(calls.findIndex((ids) => ids.includes(poster)));
  });
});

describe('a SHARED file id (Oxy dedupes by content hash) is kept while anything uses it', () => {
  it('keeps a file another post still uses, and deletes it when the last one goes', async () => {
    const x = fileId();
    const first = await federatedPost([rehosted(x)]);
    const second = await federatedPost([rehosted(x)]);

    await deletePostRecord(first, undefined);
    await drainFederatedMediaDeletions();
    expect(await stateOf(x)).toBe('in_use');
    expect(h.deleteFederatedMedia).not.toHaveBeenCalled();

    await deletePostRecord(second, undefined);
    expect(await stateOf(x)).toBe('pending');
    await drainFederatedMediaDeletions();
    expect(await stateOf(x)).toBe('deleted');
  });

  it('keeps a file a federated profile banner uses', async () => {
    const x = fileId();
    const post = await federatedPost([rehosted(x)]);
    await getDb().insert(userSettings).values({ oxyUserId: `oxy-fedmedia-banner-${seq}`, profileHeaderImage: x });
    await deletePostRecord(post, undefined);
    await drainFederatedMediaDeletions();
    expect(await stateOf(x)).toBe('in_use');
  });

  it('keeps a poster while another referenced video shares it', async () => {
    const videoA = fileId();
    const videoB = fileId();
    const poster = fileId();
    await recordFederatedPoster(videoA, poster);
    await recordFederatedPoster(videoB, poster);
    const a = await federatedPost([rehosted(videoA, 'video')]);
    await federatedPost([rehosted(videoB, 'video')]);
    await deletePostRecord(a, undefined);

    await drainFederatedMediaDeletions();
    await drainFederatedMediaDeletions();
    expect(await stateOf(videoA)).toBe('deleted');
    expect(await stateOf(poster)).toBe('in_use');
  });
});

describe('the race with an import reusing the id', () => {
  it('a tombstoned id cannot be referenced again: the insert is refused', async () => {
    const x = fileId();
    const post = await federatedPost([rehosted(x)]);
    await deletePostRecord(post, undefined);
    expect(await tombstoneUnreferenced([x])).toEqual([x]);

    await expect(federatedPost([rehosted(x)])).rejects.toBeInstanceOf(FederatedMediaGoneError);
    // Even after Oxy confirmed the delete: file ids are never reused.
    await drainFederatedMediaDeletions();
    await expect(federatedPost([rehosted(x)])).rejects.toBeInstanceOf(FederatedMediaGoneError);
  });

  it('an import that commits FIRST keeps the file: the drain waits on its lock, then sees the reference', async () => {
    const x = fileId();
    const old = await federatedPost([rehosted(x)]);
    await deletePostRecord(old, undefined);

    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let inserted = false;
    const importing = getDb().transaction(async (tx) => {
      await insertPostRecord({
        oxyUserId: OWNER,
        authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
        type: PostType.IMAGE,
        visibility: PostVisibility.PUBLIC,
        status: 'published',
        content: { variants: [{ source: 'author', text: 'reimport', tag: 'en' }], media: [rehosted(x)] },
        federation: { activityId: `https://remote.example/statuses/race-${seq}`, actorUri: 'https://remote.example/users/a' },
      }, tx);
      inserted = true;
      await released;
    });
    await vi.waitFor(() => expect(inserted).toBe(true));

    const draining = drainFederatedMediaDeletions();
    // The drain must really be BLOCKED on the import's per-file lock — assert the
    // wait itself, or this test would pass without any interleaving.
    await vi.waitFor(async () => {
      const [row] = await getDb().execute<{ waiting: number }>(sql`
        select count(*)::int as waiting from pg_locks where locktype = 'advisory' and not granted
      `);
      expect(Number(row?.waiting)).toBeGreaterThan(0);
    });

    release();
    await importing;
    await draining;
    expect(await stateOf(x)).toBe('in_use');
    expect(h.deleteFederatedMedia).not.toHaveBeenCalled();
  });
});

describe('Oxy\'s dedupe REUSES ids: an upload can bring back a file this app deleted', () => {
  it('a dedup upload of a queued (pending) id: the drain keeps the file the new post uses', async () => {
    const x = fileId();
    await deletePostRecord(await federatedPost([rehosted(x)]), undefined);
    expect(await stateOf(x)).toBe('pending');

    // The re-upload answered X (deduplicated): the new post may reference it.
    await federatedPost([rehosted(x)]);
    await drainFederatedMediaDeletions();
    expect(await stateOf(x)).toBe('in_use');
    expect(h.deleteFederatedMedia).not.toHaveBeenCalled();
  });

  it('a dedup upload that lands between the drain\'s decision and the insert: refused, then re-opened by a later upload', async () => {
    const x = fileId();
    await deletePostRecord(await federatedPost([rehosted(x)]), undefined);
    // The drain tombstones X before the import's insert; Oxy then deletes it.
    const uploadDuringDelete = new Date();
    await drainFederatedMediaDeletions();
    expect(await stateOf(x)).toBe('deleted');

    // An upload that started BEFORE the delete was confirmed may have been
    // trashed by it: it does not re-open the id, and the insert is refused.
    expect(await reviveFederatedFiles([x], uploadDuringDelete)).toEqual([]);
    await expect(federatedPost([rehosted(x)])).rejects.toBeInstanceOf(FederatedMediaGoneError);

    // The import's retry uploads again AFTER the confirmation: Oxy reactivated
    // the trashed file under the same id, so the id is live and usable again.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await reviveFederatedFiles([x], new Date())).toEqual([x]);
    expect(await stateOf(x)).toBe('in_use');
    const post = await federatedPost([rehosted(x)]);

    // And the cycle works again when that post goes.
    await deletePostRecord(post, undefined);
    expect(await stateOf(x)).toBe('pending');
    await drainFederatedMediaDeletions();
    expect(await stateOf(x)).toBe('deleted');
  });

  it('never re-opens an id whose delete is still in flight (`deleting`)', async () => {
    const x = fileId();
    await deletePostRecord(await federatedPost([rehosted(x)]), undefined);
    expect(await tombstoneUnreferenced([x])).toEqual([x]);
    expect(await reviveFederatedFiles([x], new Date(Date.now() + 60_000))).toEqual([]);
    expect(await stateOf(x)).toBe('deleting');
  });
});

describe('the batch cap (oxy-api takes at most 20 ids per call)', () => {
  it('never sends more than 20 ids in one call, and drains a larger backlog in several', async () => {
    const files = Array.from({ length: 45 }, () => fileId());
    for (const id of files) await deletePostRecord(await federatedPost([rehosted(id)]), undefined);

    await drainFederatedMediaDeletions();

    const calls = h.deleteFederatedMedia.mock.calls.map(([ids]) => ids as string[]);
    expect(Math.max(...calls.map((ids) => ids.length))).toBeLessThanOrEqual(20);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(files.every((id) => calls.some((ids) => ids.includes(id)))).toBe(true);
    for (const id of files) expect(await stateOf(id)).toBe('deleted');
  });
});

describe('only an answer from Oxy settles a deletion', () => {
  async function queued(): Promise<string> {
    const x = fileId();
    const post = await federatedPost([rehosted(x)]);
    await deletePostRecord(post, undefined);
    return x;
  }

  async function row(id: string) {
    const [r] = await getDb().select().from(federatedMediaDeletions).where(eq(federatedMediaDeletions.oxyFileId, id));
    return r;
  }

  it.each([
    ['HTTP 404 on the route (an oxy-api that predates it)', new OxyMediaStoreRequestError('delete', 404, 'Not Found')],
    ['a 5xx', new OxyMediaStoreRequestError('delete', 503, 'unavailable')],
    ['a transport failure', new Error('socket hang up')],
  ])('%s is retried later, never treated as done', async (_case, error) => {
    const x = await queued();
    h.deleteFederatedMedia.mockRejectedValueOnce(error);
    await drainFederatedMediaDeletions();

    const r = await row(x);
    expect(r).toMatchObject({ state: 'deleting', attempts: 1 });
    expect(r.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + mediaDeletionBackoffMs(0) - 5_000);
    // Not due yet: a new drain does not touch it.
    h.deleteFederatedMedia.mockClear();
    await drainFederatedMediaDeletions();
    expect(h.deleteFederatedMedia).not.toHaveBeenCalled();
  });

  it('429 waits at least the Retry-After Oxy gave', async () => {
    const x = await queued();
    h.deleteFederatedMedia.mockRejectedValueOnce(new OxyMediaStoreThrottledError('delete', 30 * 60_000));
    await drainFederatedMediaDeletions();
    const r = await row(x);
    expect(r.state).toBe('deleting');
    expect(r.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
  });

  it('not_found is done; forbidden is dropped and is NOT a tombstone', async () => {
    const gone = await queued();
    const notOurs = await queued();
    h.deleteFederatedMedia.mockImplementationOnce(async () => [
      { id: gone, result: 'not_found' },
      { id: notOurs, result: 'forbidden' },
    ]);
    await drainFederatedMediaDeletions();
    expect(await stateOf(gone)).toBe('not_found');
    expect(await stateOf(notOurs)).toBe('forbidden');
    await expect(federatedPost([rehosted(notOurs)])).resolves.toEqual(expect.any(String));
  });

  it('Oxy\'s in_use (held by another owner or app) settles with the file kept, no retry, not a tombstone', async () => {
    const x = await queued();
    h.deleteFederatedMedia.mockImplementationOnce(async () => [{ id: x, result: 'in_use' }]);
    await drainFederatedMediaDeletions();
    expect(await stateOf(x)).toBe('in_use');
    h.deleteFederatedMedia.mockClear();
    await drainFederatedMediaDeletions();
    expect(h.deleteFederatedMedia).not.toHaveBeenCalled();
    await expect(federatedPost([rehosted(x)])).resolves.toEqual(expect.any(String));
  });

  it('an id Oxy did not answer for stays owed', async () => {
    const x = await queued();
    h.deleteFederatedMedia.mockImplementationOnce(async () => []);
    await drainFederatedMediaDeletions();
    expect(await row(x)).toMatchObject({ state: 'deleting', attempts: 1 });
  });

  afterAll(async () => {
    await getDb().delete(federatedMediaDeletions).where(inArray(federatedMediaDeletions.state, ['deleting', 'pending']));
  });
});
