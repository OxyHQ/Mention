import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Offline, model-level tests for the self-thread root `threadId` backfill.
 *
 * `Post.aggregate` (candidate single-author thread groups) and `Post.find` (root
 * existence/state/ownership lookup) are mocked with canned shapes, and
 * `Post.bulkWrite` is captured. This exercises the REAL qualification guards
 * (existence, native, top-level, not-already-stamped, ownership) and the per-root
 * stamp WITHOUT depending on MongoDB's `$group` semantics (which the aggregation,
 * not this script, owns). Mirrors `scripts/migrateThreadFanToChain.test.ts`.
 */

interface CapturedOp {
  updateOne: { filter: { _id: mongoose.Types.ObjectId }; update: { $set: { threadId: string } } };
}

interface CandidateGroup {
  _id: string;
  count: number;
  authors: string[];
}

interface RootRow {
  _id: mongoose.Types.ObjectId;
  oxyUserId?: string;
  parentPostId?: string | null;
  threadId?: string | null;
  federation?: { activityId?: string };
}

const h = vi.hoisted(() => {
  const state: {
    candidates: CandidateGroup[];
    roots: RootRow[];
    capturedOps: CapturedOp[];
  } = { candidates: [], roots: [], capturedOps: [] };

  const aggregate = vi.fn(async () => state.candidates);

  const find = vi.fn((query: Record<string, any>) => ({
    lean: async () => {
      const inClause = query?._id?.$in as mongoose.Types.ObjectId[] | undefined;
      if (!Array.isArray(inClause)) return [];
      const wanted = new Set(inClause.map((id) => id.toString()));
      return state.roots.filter((r) => wanted.has(r._id.toString()));
    },
  }));

  const bulkWrite = vi.fn(async (ops: CapturedOp[]) => {
    state.capturedOps.push(...ops);
    return { modifiedCount: ops.length };
  });

  return { state, aggregate, find, bulkWrite };
});

vi.mock('../../models/Post', () => ({
  Post: { aggregate: h.aggregate, find: h.find, bulkWrite: h.bulkWrite },
}));

vi.mock('../../utils/database', () => ({
  connectToDatabase: vi.fn(async () => undefined),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.spyOn(mongoose, 'disconnect').mockResolvedValue(undefined as never);

import backfillThreadRootThreadId from '../../scripts/backfillThreadRootThreadId';

/**
 * Build a candidate thread group plus its (optional) root row. `author` is the
 * single continuation author the aggregation collected; the root defaults to the
 * same author, native, top-level, with a null threadId (the broken-root shape).
 */
function makeThread(opts: {
  author: string;
  rootAuthor?: string;
  rootThreadId?: string | null;
  rootParentPostId?: string | null;
  rootFederation?: { activityId?: string };
  rootMissing?: boolean;
  count?: number;
}): { rootId: string; group: CandidateGroup; rootRow?: RootRow } {
  const root = new mongoose.Types.ObjectId();
  const rootId = root.toString();
  const group: CandidateGroup = {
    _id: rootId,
    count: opts.count ?? 2,
    authors: [opts.author],
  };
  const rootRow = opts.rootMissing
    ? undefined
    : {
        _id: root,
        oxyUserId: opts.rootAuthor ?? opts.author,
        parentPostId: opts.rootParentPostId ?? null,
        threadId: opts.rootThreadId ?? null,
        federation: opts.rootFederation,
      };
  return { rootId, group, rootRow };
}

beforeEach(() => {
  h.state.candidates = [];
  h.state.roots = [];
  h.state.capturedOps = [];
  h.aggregate.mockClear();
  h.find.mockClear();
  h.bulkWrite.mockClear();
});

describe('backfillThreadRootThreadId', () => {
  it('stamps threadId = root._id on a native single-author self-thread root with null threadId', async () => {
    const { rootId, group, rootRow } = makeThread({ author: 'user-A' });
    h.state.candidates = [group];
    h.state.roots = rootRow ? [rootRow] : [];

    await backfillThreadRootThreadId();

    expect(h.state.capturedOps).toHaveLength(1);
    const op = h.state.capturedOps[0];
    expect(op.updateOne.filter._id.toString()).toBe(rootId);
    expect(op.updateOne.update.$set.threadId).toBe(rootId);
  });

  it('is idempotent: a root that already carries a threadId is not re-stamped', async () => {
    // Second-run state: the root was stamped on a prior run, so its threadId is set.
    const { rootId, group, rootRow } = makeThread({ author: 'user-A' });
    if (rootRow) rootRow.threadId = rootId;
    h.state.candidates = [group];
    h.state.roots = rootRow ? [rootRow] : [];

    await backfillThreadRootThreadId();

    expect(h.state.capturedOps).toHaveLength(0);
  });

  it('skips a thread whose continuations are by a different author than the root (reply tree)', async () => {
    // The single continuation author is user-B, but the root belongs to user-A:
    // a reply tree under someone else's post, NOT a self-thread.
    const { group, rootRow } = makeThread({ author: 'user-B', rootAuthor: 'user-A' });
    h.state.candidates = [group];
    h.state.roots = rootRow ? [rootRow] : [];

    await backfillThreadRootThreadId();

    expect(h.state.capturedOps).toHaveLength(0);
    expect(h.bulkWrite).not.toHaveBeenCalled();
  });

  it('skips a thread whose root is missing (cannot verify ownership)', async () => {
    const { group } = makeThread({ author: 'user-A', rootMissing: true });
    h.state.candidates = [group];
    h.state.roots = [];

    await backfillThreadRootThreadId();

    expect(h.state.capturedOps).toHaveLength(0);
  });

  it('skips a federated root (federation.activityId present)', async () => {
    const { group, rootRow } = makeThread({
      author: 'user-A',
      rootFederation: { activityId: 'https://remote.example/activities/1' },
    });
    h.state.candidates = [group];
    h.state.roots = rootRow ? [rootRow] : [];

    await backfillThreadRootThreadId();

    expect(h.state.capturedOps).toHaveLength(0);
  });

  it('skips a root that is itself a reply (has a parentPostId)', async () => {
    const { group, rootRow } = makeThread({ author: 'user-A', rootParentPostId: 'some-parent-id' });
    h.state.candidates = [group];
    h.state.roots = rootRow ? [rootRow] : [];

    await backfillThreadRootThreadId();

    expect(h.state.capturedOps).toHaveLength(0);
  });

  it('does nothing when there are no candidate threads', async () => {
    h.state.candidates = [];

    await backfillThreadRootThreadId();

    expect(h.find).not.toHaveBeenCalled();
    expect(h.bulkWrite).not.toHaveBeenCalled();
  });

  it('writes nothing in DRY_RUN mode', async () => {
    // DRY_RUN is read once at module load, so re-import the script with the env set.
    vi.stubEnv('DRY_RUN', 'true');
    vi.resetModules();
    const { default: dryRunBackfill } = await import('../../scripts/backfillThreadRootThreadId');

    const { group, rootRow } = makeThread({ author: 'user-A' });
    h.state.candidates = [group];
    h.state.roots = rootRow ? [rootRow] : [];

    await dryRunBackfill();

    expect(h.state.capturedOps).toHaveLength(0);
    expect(h.bulkWrite).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
