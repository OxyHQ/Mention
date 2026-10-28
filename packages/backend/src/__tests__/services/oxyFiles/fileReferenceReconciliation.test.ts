import { membershipCommunities, membershipMedia } from '../../../db/schema/memberships';
/**
 * The nightly reference reconciliation, against REAL rows: each entity type's
 * inventory is sent whole, every run is recorded, and an applied commit
 * replays the removals it may have undone. Only Oxy is mocked.
 *
 * Reads every entity's whole inventory and replays every recent removal, so
 * this file runs against its own database (`isolatedDatabaseFiles.ts`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  reconcile: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  inventories: new Map<string, Array<{ fileId: string; entityId: string }>>(),
  onCommit: null as null | ((entityType: string) => Promise<void>),
}));

vi.mock('../../../utils/oxyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/oxyHelpers')>()),
  getServiceOxyClient: () => ({
    assets: { references: { reconcile: h.reconcile, add: h.add, remove: h.remove } },
  }),
}));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { deletePostRecord, insertPostRecord } from '../../../db/posts/postRepository';
import { federatedMediaDeletions } from '../../../db/schema/federation';
import { oxyFileReferenceReconciliations, oxyFileReferenceSync } from '../../../db/schema/oxyFiles';
import {
  FILE_REFERENCE_ENTITIES,
  oxyEntityTypeFor,
  fileReferenceEntity,
} from '../../../db/oxyFiles/fileReferenceEntities';
import { drainFileReferenceSync } from '../../../services/oxyFiles/fileReferenceSync';
import {
  FileReferenceReconciliationScheduler,
  isReconciliationDue,
  pacedInventory,
  RECONCILE_PAGE_ITEMS,
  RECONCILE_PAGE_PAUSE_MS,
  RECONCILE_RATE_LIMIT_ATTEMPTS,
  RECONCILE_RATE_LIMIT_WAIT_MS,
  runFileReferenceReconciliation,
} from '../../../services/oxyFiles/fileReferenceReconciliation';

type Item = { fileId: string; entityId: string };
type Inventory = Iterable<Item> | AsyncIterable<Item>;

/** The inventory as Oxy reads it: the service hands the SDK a paced async stream. */
async function collect(items: Inventory): Promise<Item[]> {
  const list: Item[] = [];
  for await (const item of items) list.push(item);
  return list;
}
type Reference = { fileId: string; entityType: string; entityId: string };

const AUTHOR = 'oxy-file-ref-reconcile-author';
const fid = (label: string) => `ofrc-${label}-${randomUUID().slice(0, 8)}`;
const EXPECTED_ENTITY_TYPES = FILE_REFERENCE_ENTITIES.reduce(
  (total, entity) => total + Math.max(1, entity.shards),
  0,
);

async function post(fileIds: string[]): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.IMAGE,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: {
      variants: [{ source: 'author', text: 'reconcile', tag: 'en' }],
      media: fileIds.map((id) => ({ id, type: 'image' as const })),
    },
  });
  return record.id;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  h.inventories.clear();
  h.onCommit = null;
  h.reconcile.mockReset();
  h.reconcile.mockImplementation(
    async (entityType: string, items: Inventory, options: { dryRun?: boolean }) => {
      const list = await collect(items);
      h.inventories.set(entityType, list);
      if (h.onCommit) await h.onCommit(entityType);
      return {
        sessionId: randomUUID(),
        entityType,
        dryRun: options.dryRun === true,
        added: list.length,
        removed: 0,
        unchanged: 0,
        refused: 0,
      };
    },
  );
  h.add.mockImplementation(async (refs: Reference[]) =>
    refs.map((ref) => ({ ...ref, result: 'created' })),
  );
  h.remove.mockImplementation(async (refs: Reference[]) =>
    refs.map((ref) => ({ ...ref, result: 'removed' })),
  );
  // This file owns its database: the run history is its own.
  await getDb().delete(oxyFileReferenceReconciliations);
});

afterAll(async () => {
  await closePostgres();
});

describe('when a run is due', () => {
  const night = (hour: number) => new Date(Date.UTC(2026, 9, 16, hour, 30));

  it('runs at night only, and at most once a night', () => {
    expect(isReconciliationDue(night(3), null)).toBe(true);
    expect(isReconciliationDue(night(12), null)).toBe(false);
    expect(isReconciliationDue(night(1), null)).toBe(false);
    expect(isReconciliationDue(night(4), night(2))).toBe(false);
    expect(isReconciliationDue(night(3), new Date(night(3).getTime() - 23 * 3_600_000))).toBe(true);
  });

  it('the scheduler asks the run history, so a second tick the same night does nothing', async () => {
    const run = vi.fn(async (mode: 'dry_run' | 'apply') => {
      await getDb().insert(oxyFileReferenceReconciliations).values({
        runId: randomUUID(),
        entityType: 'gif',
        oxyEntityType: 'gif',
        mode,
      });
      return { runId: randomUUID(), mode, entityTypes: [] };
    });
    const scheduler = new FileReferenceReconciliationScheduler(run, () => new Date());
    // Always "at night" for the test, whatever the wall clock says.
    vi.spyOn(Date.prototype, 'getUTCHours').mockReturnValue(3);
    try {
      scheduler.start();
      await scheduler.tick();
      await scheduler.tick();
    } finally {
      scheduler.stop();
      vi.restoreAllMocks();
    }
    expect(run).toHaveBeenCalledTimes(1);
    // The nightly run always applies; a dry run is an operator's preview.
    expect(run).toHaveBeenCalledWith('apply');
  });
});

describe('a dry run', () => {
  it('sends every entity type its whole inventory, commits nothing and records the counts', async () => {
    const file = fid('dry');
    const id = await post([file]);

    const result = await runFileReferenceReconciliation('dry_run');

    expect(h.reconcile).toHaveBeenCalledTimes(EXPECTED_ENTITY_TYPES);
    for (const call of h.reconcile.mock.calls) expect(call[2]).toEqual({ dryRun: true });
    const shardType = oxyEntityTypeFor(fileReferenceEntity('post'), id);
    expect(h.inventories.get(shardType)).toContainEqual({ fileId: file, entityId: id });
    expect(result.entityTypes.every((entry) => entry.ok)).toBe(true);

    const rows = await getDb()
      .select()
      .from(oxyFileReferenceReconciliations)
      .where(eq(oxyFileReferenceReconciliations.runId, result.runId));
    expect(rows).toHaveLength(EXPECTED_ENTITY_TYPES);
    expect(rows.every((row) => row.outcome === 'completed' && row.mode === 'dry_run')).toBe(true);
    const shardRow = rows.find((row) => row.oxyEntityType === shardType);
    expect(shardRow?.items).toBe(h.inventories.get(shardType)?.length);
    expect(shardRow?.replayed).toBe(0);
    await deletePostRecord(id);
  });

  it('records a failed entity type and still reconciles the rest', async () => {
    h.reconcile.mockImplementation(async (entityType: string, items: Inventory) => {
      const list = await collect(items);
      if (entityType === 'gif') {
        throw Object.assign(new Error('busy'), { status: 409, code: 'RECONCILIATION_IN_PROGRESS' });
      }
      return {
        sessionId: 's',
        entityType,
        dryRun: true,
        added: list.length,
        removed: 0,
        unchanged: 0,
        refused: 0,
      };
    });

    const result = await runFileReferenceReconciliation('dry_run');

    const failed = result.entityTypes.filter((entry) => !entry.ok);
    expect(failed.map((entry) => entry.oxyEntityType)).toEqual(['gif']);
    expect(failed[0].error).toContain('409');
    const [row] = await getDb()
      .select()
      .from(oxyFileReferenceReconciliations)
      .where(eq(oxyFileReferenceReconciliations.oxyEntityType, 'gif'));
    expect(row.outcome).toBe('failed');
    expect(result.entityTypes).toHaveLength(EXPECTED_ENTITY_TYPES);
  });

  it('waits out a 429 and tries the entity type again', async () => {
    let refusals = 0;
    h.reconcile.mockImplementation(async (entityType: string, items: Inventory) => {
      const list = await collect(items);
      if (entityType === 'gif' && refusals < 2) {
        refusals += 1;
        throw Object.assign(new Error('slow down'), { status: 429 });
      }
      return {
        sessionId: 's',
        entityType,
        dryRun: true,
        added: list.length,
        removed: 0,
        unchanged: 0,
        refused: 0,
      };
    });
    const pause = vi.fn(async (_ms: number) => undefined);

    const result = await runFileReferenceReconciliation('dry_run', { pause });

    expect(result.entityTypes.every((entry) => entry.ok)).toBe(true);
    expect(h.reconcile.mock.calls.filter(([entityType]) => entityType === 'gif')).toHaveLength(3);
    expect(pause.mock.calls.filter(([ms]) => ms === RECONCILE_RATE_LIMIT_WAIT_MS)).toHaveLength(2);
  });

  it('gives up on an entity type Oxy keeps refusing with 429', async () => {
    h.reconcile.mockImplementation(async (entityType: string, items: Inventory) => {
      const list = await collect(items);
      if (entityType === 'gif') throw Object.assign(new Error('slow down'), { status: 429 });
      return {
        sessionId: 's',
        entityType,
        dryRun: true,
        added: list.length,
        removed: 0,
        unchanged: 0,
        refused: 0,
      };
    });

    const result = await runFileReferenceReconciliation('dry_run', {
      pause: async () => undefined,
    });

    const failed = result.entityTypes.filter((entry) => !entry.ok);
    expect(failed.map((entry) => entry.oxyEntityType)).toEqual(['gif']);
    expect(failed[0].error).toContain('429');
    expect(h.reconcile.mock.calls.filter(([entityType]) => entityType === 'gif')).toHaveLength(
      RECONCILE_RATE_LIMIT_ATTEMPTS,
    );
  });
});

describe('pacing', () => {
  it('pauses between pages, never before the first', async () => {
    const items = Array.from({ length: RECONCILE_PAGE_ITEMS * 2 + 1 }, (_, index) => ({
      fileId: `f${index}`,
      entityId: `e${index}`,
    }));
    const pause = vi.fn(async (_ms: number) => undefined);

    const streamed = await collect(pacedInventory(items, pause));

    expect(streamed).toEqual(items);
    expect(pause.mock.calls).toEqual([[RECONCILE_PAGE_PAUSE_MS], [RECONCILE_PAGE_PAUSE_MS]]);
  });
});

describe('an applied run', () => {
  it('re-sends a removal answered while its inventory was read, and re-opens its in_use deletion', async () => {
    const file = fid('race');
    const id = await post([file]);
    await drainFileReferenceSync(); // Oxy holds (file, post)
    const shardType = oxyEntityTypeFor(fileReferenceEntity('post'), id);
    await getDb()
      .insert(federatedMediaDeletions)
      .values({ oxyFileId: file, state: 'in_use', settledAt: new Date() });

    // Between the inventory read and the commit: the post is deleted and the
    // drain removes its reference — which the commit then re-adds.
    h.onCommit = async (entityType) => {
      if (entityType !== shardType) return;
      await deletePostRecord(id);
      await drainFileReferenceSync();
    };

    const result = await runFileReferenceReconciliation('apply');

    expect(h.inventories.get(shardType)).toContainEqual({ fileId: file, entityId: id });
    const entry = result.entityTypes.find((candidate) => candidate.oxyEntityType === shardType);
    expect(entry?.replayed).toBeGreaterThanOrEqual(1);
    const [sync] = await getDb()
      .select()
      .from(oxyFileReferenceSync)
      .where(eq(oxyFileReferenceSync.fileId, file));
    expect(sync).toMatchObject({ state: 'pending', syncedOp: null });
    const [deletion] = await getDb()
      .select({ state: federatedMediaDeletions.state })
      .from(federatedMediaDeletions)
      .where(eq(federatedMediaDeletions.oxyFileId, file));
    expect(deletion.state).toBe('pending');

    // The next drain removes the reference the commit re-added.
    h.remove.mockClear();
    await drainFileReferenceSync();
    expect(h.remove.mock.calls.flatMap(([refs]) => refs as Reference[])).toContainEqual(
      expect.objectContaining({ fileId: file, entityId: id }),
    );
  });
});

it('keeps expired upload drafts in dry-run inventories and releases them before an applied inventory', async () => {
  const communityId = randomUUID();
  await getDb()
    .insert(membershipCommunities)
    .values({
      id: communityId,
      ownerOxyUserId: AUTHOR,
      slug: `draft-${communityId}`,
      name: 'Draft lifecycle',
      description: '',
    });
  const [draft] = await getDb()
    .insert(membershipMedia)
    .values({
      communityId,
      ownerOxyUserId: AUTHOR,
      fileId: fid('expired-draft'),
      mime: 'image/png',
      size: 4,
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    })
    .returning();
  if (!draft) throw new Error('Missing draft');
  await runFileReferenceReconciliation('dry_run');
  expect(h.inventories.get('membership_media')).toContainEqual({
    fileId: draft.fileId,
    entityId: draft.id,
  });
  expect(
    await getDb().select().from(membershipMedia).where(eq(membershipMedia.id, draft.id)),
  ).toHaveLength(1);
  await runFileReferenceReconciliation('apply');
  expect(h.inventories.get('membership_media')).not.toContainEqual({
    fileId: draft.fileId,
    entityId: draft.id,
  });
  expect(
    await getDb().select().from(membershipMedia).where(eq(membershipMedia.id, draft.id)),
  ).toEqual([]);
});
