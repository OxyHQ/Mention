/**
 * The Oxy file-reference drain, against REAL rows: the triggers mark, the drain
 * decides from the current data and tells Oxy only the difference. Only the
 * Oxy calls (`OxyServer.assets.references`) are mocked.
 *
 * The drain sweeps the WHOLE outbox, so this file runs against its own database
 * (`isolatedDatabaseFiles.ts`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  add: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../../utils/oxyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/oxyHelpers')>()),
  getServiceOxyClient: () => ({ assets: { references: { add: h.add, remove: h.remove } } }),
}));

import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { config } from '../../../config';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import {
  deletePostRecord,
  insertPostRecord,
  replacePostContent,
} from '../../../db/posts/postRepository';
import { oxyFileReferenceSync } from '../../../db/schema/oxyFiles';
import { markFileReferences } from '../../../db/oxyFiles/fileReferenceSyncRepository';
import {
  clearFileReferencesBeforeDelete,
  drainFileReferenceSync,
  fileReferenceBackoffMs,
} from '../../../services/oxyFiles/fileReferenceSync';

type Reference = { fileId: string; entityType: string; entityId: string };

const AUTHOR = 'oxy-file-ref-sync-author';
const fid = (label: string) => `ofs-${label}-${randomUUID().slice(0, 8)}`;

async function post(fileIds: string[]): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.IMAGE,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: {
      variants: [{ source: 'author', text: 'sync', tag: 'en' }],
      media: fileIds.map((id) => ({ id, type: 'image' as const })),
    },
  });
  return record.id;
}

async function rowOf(fileId: string) {
  const [row] = await getDb()
    .select()
    .from(oxyFileReferenceSync)
    .where(eq(oxyFileReferenceSync.fileId, fileId));
  return row;
}

function oxyAnswers(result: { add?: string; remove?: string } = {}) {
  h.add.mockImplementation(async (refs: Reference[]) =>
    refs.map((ref) => ({ ...ref, result: result.add ?? 'created' })),
  );
  h.remove.mockImplementation(async (refs: Reference[]) =>
    refs.map((ref) => ({ ...ref, result: result.remove ?? 'removed' })),
  );
}

const sent = (mock: typeof h.add) => mock.mock.calls.flatMap(([refs]) => refs as Reference[]);

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  h.add.mockReset();
  h.remove.mockReset();
  oxyAnswers();
  (config.oxyFiles as { referencesEnabled: boolean }).referencesEnabled = true;
});

afterAll(async () => {
  await closePostgres();
});

describe('the drain tells Oxy the difference', () => {
  it("adds a new post's files under the post's sharded entity type", async () => {
    const file = fid('new');
    const id = await post([file]);

    const result = await drainFileReferenceSync();

    expect(sent(h.add)).toContainEqual({
      fileId: file,
      entityType: expect.stringMatching(/^post\.\d{2}$/),
      entityId: id,
    });
    expect(result.added).toBeGreaterThanOrEqual(1);
    const row = await rowOf(file);
    expect(row).toMatchObject({ state: 'synced', syncedOp: 'add', attempts: 0 });
    expect(row.expiresAt).not.toBeNull();
    await deletePostRecord(id);
  });

  it('removes a deleted post’s references', async () => {
    const file = fid('gone');
    const id = await post([file]);
    await drainFileReferenceSync();
    h.add.mockClear();

    await deletePostRecord(id);
    await drainFileReferenceSync();

    expect(sent(h.remove)).toContainEqual(expect.objectContaining({ fileId: file, entityId: id }));
    expect(await rowOf(file)).toMatchObject({ state: 'synced', syncedOp: 'remove' });
  });

  it('sends nothing when an edit re-inserts the same file (already added)', async () => {
    const file = fid('same');
    const id = await post([file]);
    await drainFileReferenceSync();
    h.add.mockClear();

    await replacePostContent(
      id,
      {
        variants: [{ source: 'author', text: 'edited', tag: 'en' }],
        media: [{ id: file, type: 'image' }],
      },
      [],
    );
    expect((await rowOf(file)).state).toBe('pending');
    const result = await drainFileReferenceSync();

    expect(sent(h.add).some((ref) => ref.fileId === file)).toBe(false);
    expect(result.unchanged).toBeGreaterThanOrEqual(1);
    expect(await rowOf(file)).toMatchObject({ state: 'synced', syncedOp: 'add' });
    await deletePostRecord(id);
  });

  it("records Oxy's refusal of an add (a private file) as refused, and retries it on the next mark", async () => {
    const file = fid('private');
    const id = await post([file]);
    oxyAnswers({ add: 'not_found' });

    const result = await drainFileReferenceSync();

    expect(result.refused).toBeGreaterThanOrEqual(1);
    expect(await rowOf(file)).toMatchObject({ state: 'refused', syncedOp: null });
    await markFileReferences([{ fileId: file, entityType: 'post', entityId: id }]);
    expect((await rowOf(file)).state).toBe('pending');
    oxyAnswers();
    await drainFileReferenceSync();
    expect(await rowOf(file)).toMatchObject({ state: 'synced', syncedOp: 'add' });
    await deletePostRecord(id);
  });

  it('backs a pair off when Oxy fails, without reading the failure as an answer', async () => {
    const file = fid('down');
    const id = await post([file]);
    h.add.mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503 }));

    const result = await drainFileReferenceSync();

    expect(result.retried).toBeGreaterThanOrEqual(1);
    const row = await rowOf(file);
    expect(row).toMatchObject({ state: 'pending', syncedOp: null, attempts: 1 });
    expect(row.lastError).toContain('HTTP 503');
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + fileReferenceBackoffMs(0) / 2);
    await deletePostRecord(id);
  });

  it('a mark that lands while Oxy is answering keeps the row pending for the next run', async () => {
    const file = fid('race');
    const id = await post([file]);
    h.add.mockImplementation(async (refs: Reference[]) => {
      // The post is edited while the request is in flight.
      await markFileReferences([{ fileId: file, entityType: 'post', entityId: id }]);
      return refs.map((ref) => ({ ...ref, result: 'created' }));
    });

    await drainFileReferenceSync();

    expect(await rowOf(file)).toMatchObject({ state: 'pending', syncedOp: null });
    oxyAnswers();
    await drainFileReferenceSync();
    expect(await rowOf(file)).toMatchObject({ state: 'synced', syncedOp: 'add' });
    await deletePostRecord(id);
  });

  it('OXY_FILE_REFERENCES_ENABLED=false pauses the drain without losing a mark', async () => {
    const file = fid('paused');
    const id = await post([file]);
    (config.oxyFiles as { referencesEnabled: boolean }).referencesEnabled = false;

    await drainFileReferenceSync();

    expect(h.add).not.toHaveBeenCalled();
    expect((await rowOf(file)).state).toBe('pending');
    (config.oxyFiles as { referencesEnabled: boolean }).referencesEnabled = true;
    await drainFileReferenceSync();
    expect(await rowOf(file)).toMatchObject({ state: 'synced', syncedOp: 'add' });
    await deletePostRecord(id);
  });

  it('never sends more than 100 references in one call', async () => {
    // Four files per post: 104 pairs from 26 posts, one call past the cap.
    const files = Array.from({ length: 104 }, (_, index) => fid(`bulk${index}`));
    const ids: string[] = [];
    for (let start = 0; start < files.length; start += 4) {
      ids.push(await post(files.slice(start, start + 4)));
    }

    await drainFileReferenceSync();

    for (const [refs] of h.add.mock.calls)
      expect((refs as Reference[]).length).toBeLessThanOrEqual(100);
    const rows = await getDb()
      .select({ syncedOp: oxyFileReferenceSync.syncedOp })
      .from(oxyFileReferenceSync)
      .where(inArray(oxyFileReferenceSync.fileId, files));
    expect(rows.every((row) => row.syncedOp === 'add')).toBe(true);
    for (const id of ids) await deletePostRecord(id);
  }, 30_000);
});

describe('clearing Mention’s references before a delete', () => {
  it('re-sends the removal of a pair Oxy was told `add`, and only then reports the file clear', async () => {
    const file = fid('clear');
    const id = await post([file]);
    await drainFileReferenceSync();
    await deletePostRecord(id); // marked, not yet drained
    h.remove.mockClear();

    const clear = await clearFileReferencesBeforeDelete([file]);

    expect(clear.has(file)).toBe(true);
    expect(sent(h.remove)).toContainEqual(expect.objectContaining({ fileId: file, entityId: id }));
    expect(await rowOf(file)).toMatchObject({ state: 'synced', syncedOp: 'remove' });
  });

  it('needs no call for a settled removal, and re-sends a refused or pending pair', async () => {
    const file = fid('resend');
    const id = await post([file]);
    await deletePostRecord(id);
    await drainFileReferenceSync();
    expect(await rowOf(file)).toMatchObject({ syncedOp: 'remove' });
    h.remove.mockClear();

    await getDb()
      .update(oxyFileReferenceSync)
      .set({ syncedAt: sql`now() - interval '1 hour'` })
      .where(eq(oxyFileReferenceSync.fileId, file));
    const clear = await clearFileReferencesBeforeDelete([file]);

    // A settled removal is certain (a reconciliation that re-adds one replays
    // it itself — fileReferenceReconciliation.ts) …
    expect(clear.has(file)).toBe(true);
    expect(h.remove).not.toHaveBeenCalled();
    // … a refused or pending row is not.
    await getDb()
      .update(oxyFileReferenceSync)
      .set({ state: 'refused', syncedOp: null })
      .where(eq(oxyFileReferenceSync.fileId, file));
    expect((await clearFileReferencesBeforeDelete([file])).has(file)).toBe(true);
    expect(sent(h.remove)).toContainEqual(expect.objectContaining({ fileId: file }));
  });

  it('reports a file not clear while Oxy does not answer the removal', async () => {
    const file = fid('stuck');
    const id = await post([file]);
    await drainFileReferenceSync();
    await deletePostRecord(id);
    h.remove.mockRejectedValue(Object.assign(new Error('down'), { status: 502 }));

    const clear = await clearFileReferencesBeforeDelete([file]);

    expect(clear.has(file)).toBe(false);
    expect((await rowOf(file)).state).toBe('pending');
  });

  it('a file Mention never referenced is clear without a call', async () => {
    const file = fid('never');
    expect((await clearFileReferencesBeforeDelete([file])).has(file)).toBe(true);
    expect(h.remove).not.toHaveBeenCalled();
  });
});
