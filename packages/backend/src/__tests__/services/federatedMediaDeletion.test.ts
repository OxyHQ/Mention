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

const h = vi.hoisted(() => ({ deleteFederatedMedia: vi.fn(), tombstoneFailure: null as Error | null }));

vi.mock('../../services/mediaCache/oxyMediaStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/mediaCache/oxyMediaStore')>()),
  deleteFederatedMedia: h.deleteFederatedMedia,
}));

vi.mock('../../db/federation/mediaDeletionRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/federation/mediaDeletionRepository')>();
  return {
    ...actual,
    tombstoneUnreferenced: async (ids: string[]) => {
      if (h.tombstoneFailure) throw h.tombstoneFailure;
      return actual.tombstoneUnreferenced(ids);
    },
  };
});

import { eq, inArray, sql } from 'drizzle-orm';
import { PostType, PostVisibility, type MediaItem } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { federatedMediaDeletions, federatedMediaPosters } from '../../db/schema/federation';
import { userSettings } from '../../db/schema/userProfile';
import { deletePostRecord, insertPostRecord, replacePostContent } from '../../db/posts/postRepository';
import { postContentVariants, postMedia, postVariantAltTexts, postVariantMedia } from '../../db/schema/postContent';
import { config } from '../../config';
import { metrics } from '../../utils/metrics';
import {
  FederatedMediaGoneError,
  recordFederatedPoster,
  enqueueFederatedMediaDeletions,
  findGoneFederatedMedia,
  reviveFederatedFiles,
  tombstoneUnreferenced,
} from '../../db/federation/mediaDeletionRepository';
import { drainFederatedMediaDeletions, mediaDeletionBackoffMs, STUCK_ATTEMPTS } from '../../services/mediaCache/federatedMediaDeletion';
import { OxyMediaStoreRequestError, OxyMediaStoreThrottledError } from '../../services/mediaCache/oxyMediaStore';

const OWNER = 'oxy-fedmedia-owner';
let seq = 0;
const fileId = () => `fedmedia-file-${(seq += 1)}`;

function rehosted(id: string, type: MediaItem['type'] = 'image'): MediaItem {
  return { id, type, remoteUrl: `https://cdn.example/${id}.jpg`, cachedFromFederation: true };
}

async function federatedPost(
  media: MediaItem[],
  goneMediaPolicy?: 'refuse' | 'remote-url',
  variant: { media?: MediaItem[]; alt?: Record<string, string> } = {},
): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: OWNER,
    authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
    type: PostType.IMAGE,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'post', tag: 'en', ...variant }], media },
    federation: {
      activityId: `https://remote.example/statuses/${(seq += 1)}`,
      actorUri: 'https://remote.example/users/a',
      ...(goneMediaPolicy ? { goneMediaPolicy } : {}),
    },
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
  it('a tombstoned id cannot be referenced again: an expiring-URL source (Instagram) is refused', async () => {
    const x = fileId();
    const post = await federatedPost([rehosted(x)]);
    await deletePostRecord(post, undefined);
    expect(await tombstoneUnreferenced([x])).toEqual([x]);

    await expect(federatedPost([rehosted(x)], 'refuse')).rejects.toBeInstanceOf(FederatedMediaGoneError);
    await drainFederatedMediaDeletions();
    await expect(federatedPost([rehosted(x)], 'refuse')).rejects.toBeInstanceOf(FederatedMediaGoneError);
  });

  it('an ActivityPub post is NOT lost while a delete is unsettled: its item keeps the stable remote URL', async () => {
    const x = fileId();
    await deletePostRecord(await federatedPost([rehosted(x)]), undefined);
    expect(await tombstoneUnreferenced([x])).toEqual([x]);

    const post = await federatedPost([rehosted(x)]);
    const media = await getDb().select({ mediaId: postMedia.mediaId, cached: postMedia.cachedFromFederation })
      .from(postMedia).where(eq(postMedia.postId, post));
    expect(media).toEqual([{ mediaId: `https://cdn.example/${x}.jpg`, cached: null }]);
    await drainFederatedMediaDeletions(); // settle the claimed row for later tests
  });

  it('the remote-URL fallback keeps the alt texts (keyed by media id) with their item', async () => {
    const x = fileId();
    const y = fileId();
    const kept = fileId();
    await deletePostRecord(await federatedPost([rehosted(x)], undefined, { media: [rehosted(y)] }), undefined);
    expect((await tombstoneUnreferenced([x, y])).sort()).toEqual([x, y].sort());

    const post = await federatedPost([rehosted(x), rehosted(kept)], undefined, {
      media: [rehosted(y)],
      alt: { [x]: 'a cat on a sofa', [y]: 'the same cat, cropped', [kept]: 'a dog' },
    });

    const [variant] = await getDb().select({ id: postContentVariants.id }).from(postContentVariants).where(eq(postContentVariants.postId, post));
    const overrides = await getDb().select({ mediaId: postVariantMedia.mediaId }).from(postVariantMedia).where(eq(postVariantMedia.variantId, variant.id));
    expect(overrides).toEqual([{ mediaId: `https://cdn.example/${y}.jpg` }]);
    const alts = await getDb().select({ mediaId: postVariantAltTexts.mediaId, description: postVariantAltTexts.description })
      .from(postVariantAltTexts).where(eq(postVariantAltTexts.variantId, variant.id));
    expect(Object.fromEntries(alts.map((row) => [row.mediaId, row.description]))).toEqual({
      [`https://cdn.example/${x}.jpg`]: 'a cat on a sofa',
      [`https://cdn.example/${y}.jpg`]: 'the same cat, cropped',
      [kept]: 'a dog',
    });
    await drainFederatedMediaDeletions();
  });

  it('an item without an Oxy id has nothing to lock or check (it is stored as before)', async () => {
    const legacy = { type: 'image', remoteUrl: 'https://cdn.example/no-id.jpg' } as unknown as MediaItem;
    await expect(federatedPost([legacy])).resolves.toEqual(expect.any(String));
  });

  it('locks and checks EVERY media id, not only items flagged as re-hosted', async () => {
    const x = fileId();
    await deletePostRecord(await federatedPost([rehosted(x)]), undefined);
    expect(await tombstoneUnreferenced([x])).toEqual([x]);
    await expect(federatedPost([{ id: x, type: 'image' }], 'refuse')).rejects.toBeInstanceOf(FederatedMediaGoneError);
    await drainFederatedMediaDeletions();
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
    await expect(federatedPost([rehosted(x)], 'refuse')).rejects.toBeInstanceOf(FederatedMediaGoneError);

    // The import's retry uploads again AFTER the confirmation: Oxy reactivated
    // the trashed file under the same id, so the id is live and usable again.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await reviveFederatedFiles([x], new Date())).toEqual([x]);
    // Re-opened, but not yet a reference: pending, due only after a grace period.
    expect(await stateOf(x)).toBe('pending');
    const post = await federatedPost([rehosted(x)], 'refuse');

    // And the cycle works again when that post goes. The re-queue does not
    // cut the grace period short (that would churn a file an import is about
    // to use): the delete waits at most one grace period, then proceeds.
    await deletePostRecord(post, undefined);
    expect(await stateOf(x)).toBe('pending');
    await getDb().update(federatedMediaDeletions).set({ nextAttemptAt: new Date(Date.now() - 1_000) }).where(eq(federatedMediaDeletions.oxyFileId, x));
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
    // The backlog itself, in one statement: this is about how the drain splits
    // it, and a post's delete queuing its files is proven above. (Seeding it
    // through 45 post inserts + deletes, one after another, took seconds under
    // CI load for no extra coverage.)
    const files = Array.from({ length: 45 }, () => fileId());
    await getDb().insert(federatedMediaDeletions).values(files.map((oxyFileId) => ({ oxyFileId })));

    await drainFederatedMediaDeletions();

    const calls = h.deleteFederatedMedia.mock.calls.map(([ids]) => ids as string[]);
    expect(Math.max(...calls.map((ids) => ids.length))).toBeLessThanOrEqual(20);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(files.every((id) => calls.some((ids) => ids.includes(id)))).toBe(true);
    for (const id of files) expect(await stateOf(id)).toBe('deleted');
  });
});

describe('the per-file locks', () => {
  it('are taken in ONE round trip however many files a post or batch has, all held to commit', async () => {
    const files = Array.from({ length: 20 }, () => fileId());
    const measured = await getDb().transaction(async (tx) => {
      let statements = 0;
      const counting = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === 'execute') {
            return (...args: Parameters<typeof tx.execute>) => {
              statements += 1;
              return target.execute(...args);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await findGoneFederatedMedia(counting, files);
      const [row] = await tx.execute<{ held: number }>(sql`
        select count(*)::int as held from pg_locks
        where locktype = 'advisory' and granted and pid = pg_backend_pid()
      `);
      return { statements, held: Number(row?.held) };
    });
    expect(measured.statements).toBe(1);
    expect(measured.held).toBe(20);
  });
});

describe('nothing leaks, nothing jams', () => {
  it('re-queuing a revived file does NOT cancel its grace period (no upload/delete churn)', async () => {
    const x = fileId();
    await deletePostRecord(await federatedPost([rehosted(x)]), undefined);
    await drainFederatedMediaDeletions();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await reviveFederatedFiles([x], new Date())).toEqual([x]);
    const due = async () => (await getDb().select({ at: federatedMediaDeletions.nextAttemptAt }).from(federatedMediaDeletions)
      .where(eq(federatedMediaDeletions.oxyFileId, x)))[0].at.getTime();
    const graceEnds = await due();
    expect(graceEnds).toBeGreaterThan(Date.now() + 30 * 60_000);

    // Another post using the file is deleted, or Instagram retries and queues it.
    await enqueueFederatedMediaDeletions([x]);
    expect(await due()).toBe(graceEnds);
    h.deleteFederatedMedia.mockClear();
    await drainFederatedMediaDeletions();
    expect(h.deleteFederatedMedia).not.toHaveBeenCalled();

    // Once the grace period is over, a re-queue re-arms it as usual.
    await getDb().update(federatedMediaDeletions).set({ nextAttemptAt: new Date(Date.now() - 1_000) }).where(eq(federatedMediaDeletions.oxyFileId, x));
    await enqueueFederatedMediaDeletions([x]);
    await drainFederatedMediaDeletions();
    expect(await stateOf(x)).toBe('deleted');
  });

  it('a revived file whose insert then FAILED is deleted again after the grace period', async () => {
    const x = fileId();
    await deletePostRecord(await federatedPost([rehosted(x)]), undefined);
    await drainFederatedMediaDeletions();
    expect(await stateOf(x)).toBe('deleted');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await reviveFederatedFiles([x], new Date())).toEqual([x]);

    // No post ever referenced it. Not due yet…
    h.deleteFederatedMedia.mockClear();
    await drainFederatedMediaDeletions();
    expect(h.deleteFederatedMedia).not.toHaveBeenCalled();
    // …and once the grace period is over, it is deleted again.
    await getDb().update(federatedMediaDeletions).set({ nextAttemptAt: new Date(Date.now() - 1_000) }).where(eq(federatedMediaDeletions.oxyFileId, x));
    await drainFederatedMediaDeletions();
    expect(await stateOf(x)).toBe('deleted');
  });

  it('an edit that drops a re-hosted file queues it; a file the edit keeps is not queued', async () => {
    const kept = fileId();
    const dropped = fileId();
    const post = await federatedPost([rehosted(kept), rehosted(dropped)]);
    await replacePostContent(post, { variants: [{ source: 'author', text: 'edited', tag: 'en' }], media: [rehosted(kept)] }, []);
    expect(await stateOf(dropped)).toBe('pending');
    expect(await stateOf(kept)).toBeUndefined();
  });

  it('a failing reference check BACKS OFF its rows instead of re-selecting them forever', async () => {
    const x = fileId();
    await deletePostRecord(await federatedPost([rehosted(x)]), undefined);
    h.tombstoneFailure = new Error('database hiccup');
    try {
      await drainFederatedMediaDeletions();
    } finally {
      h.tombstoneFailure = null;
    }
    const [row] = await getDb().select().from(federatedMediaDeletions).where(eq(federatedMediaDeletions.oxyFileId, x));
    expect(row).toMatchObject({ state: 'pending', attempts: 1 });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(h.deleteFederatedMedia).not.toHaveBeenCalled();
  });

  it('reports deletions Oxy keeps failing to answer (the stuck gauge)', async () => {
    const x = fileId();
    await deletePostRecord(await federatedPost([rehosted(x)]), undefined);
    await getDb().update(federatedMediaDeletions)
      .set({ attempts: STUCK_ATTEMPTS, nextAttemptAt: new Date(Date.now() + 3_600_000) })
      .where(eq(federatedMediaDeletions.oxyFileId, x));
    await drainFederatedMediaDeletions();
    expect(metrics.getGauge('federated_media_delete_stuck')).toBeGreaterThanOrEqual(1);
  });

  it('prunes old forbidden rows and poster pairs whose video is gone — never tombstones', async () => {
    const notOurs = fileId();
    const video = fileId();
    const poster = fileId();
    await getDb().insert(federatedMediaDeletions).values([
      { oxyFileId: notOurs, state: 'forbidden', updatedAt: new Date(Date.now() - 31 * 86_400_000) },
      { oxyFileId: video, state: 'deleted', settledAt: new Date() },
      { oxyFileId: poster, state: 'pending', nextAttemptAt: new Date(Date.now() + 3_600_000) },
    ]);
    await recordFederatedPoster(video, poster);
    await drainFederatedMediaDeletions();
    expect(await stateOf(notOurs)).toBeUndefined();
    expect(await stateOf(video)).toBe('deleted');
    const pairs = await getDb().select().from(federatedMediaPosters).where(eq(federatedMediaPosters.videoFileId, video));
    expect(pairs).toEqual([]);
  });

  it('FEDERATED_MEDIA_DELETE_ENABLED=false pauses the drain without losing a queued row', async () => {
    const x = fileId();
    await deletePostRecord(await federatedPost([rehosted(x)]), undefined);
    config.federatedMediaDeletion.enabled = false;
    try {
      await drainFederatedMediaDeletions();
      expect(h.deleteFederatedMedia).not.toHaveBeenCalled();
      expect(await stateOf(x)).toBe('pending');
    } finally {
      config.federatedMediaDeletion.enabled = true;
    }
    await drainFederatedMediaDeletions();
    expect(await stateOf(x)).toBe('deleted');
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
