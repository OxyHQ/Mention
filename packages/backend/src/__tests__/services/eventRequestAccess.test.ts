import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PostType, PostVisibility } from '@mention/shared-types';
import { connectPostgres, closePostgres } from '../../db/postgres';
import { insertPostRecord, deletePostRecord } from '../../db/posts/postRepository';
import { eventAccessFor } from '../../services/eventRequestAccess';
import { listEventAttendees, registerForEvent } from '../../services/EventAttendanceService';
import type { OxyAuthRequest } from '@oxy.so/core/server';
const state = vi.hoisted(() => ({ members: [] as unknown[], readable: true }));
vi.mock('../../utils/oxyHelpers', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createScopedOxyClient: () => ({}),
  createUserScopedOxyServices: () => ({
    accounts: { members: { list: async () => state.members } },
  }),
}));
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { canViewerReadPostId: vi.fn(async () => state.readable) },
  resolveUserSummaries: vi.fn(
    async (ids: string[]) =>
      new Map(
        ids.map((id) => [
          id,
          { user: { id, kind: id === 'event-channel' ? 'channel' : 'personal' } },
        ]),
      ),
  ),
}));
const ids: string[] = [];
beforeAll(connectPostgres);
afterAll(async () => {
  for (const id of ids) await deletePostRecord(id, undefined);
  await closePostgres();
});
function request(id: string) {
  return { user: { id } } as OxyAuthRequest;
}
it('full roster follows live account membership, not original writer identity; a removed operator is denied on the next request', async () => {
  const post = await insertPostRecord({
    oxyUserId: 'event-channel',
    writtenByOxyUserId: 'writer',
    authorship: [{ oxyUserId: 'event-channel', role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { event: { name: 'Town hall', date: new Date(Date.now() + 86400000).toISOString() } },
  });
  ids.push(post.id);
  state.members = [{ memberUserId: 'operator', status: 'active' }];
  const allowed = eventAccessFor(request('operator'), post.id);
  expect(await allowed.manage()).toBe(true);
  await registerForEvent(post.id, eventAccessFor(request('attendee'), post.id), false);
  expect((await listEventAttendees(post.id, allowed, true)).items).toHaveLength(1);
  state.members = [];
  await expect(
    listEventAttendees(post.id, eventAccessFor(request('operator'), post.id), true),
  ).rejects.toMatchObject({ status: 404 });
  expect(await eventAccessFor(request('writer'), post.id).manage()).toBe(false);
  expect(await eventAccessFor(request('stranger'), post.id).manage()).toBe(false);
  state.readable = false;
  await expect(
    registerForEvent(post.id, eventAccessFor(request('attendee'), post.id), true),
  ).rejects.toMatchObject({ status: 404 });
});

it('generic post edit refuses event changes with an explicit management handoff', async () => {
  const { updatePost } = await import('../../controllers/posts/updatePost');
  const post = await insertPostRecord({
    oxyUserId: 'personal-owner',
    authorship: [{ oxyUserId: 'personal-owner', role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { event: { name: 'Existing', date: new Date(Date.now() + 86400000).toISOString() } },
  });
  ids.push(post.id);
  let status = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      payload = value;
      return this;
    },
  };
  await updatePost(
    {
      user: { id: 'personal-owner' },
      params: { id: post.id },
      body: { content: { event: { name: 'Bypass' } } },
    } as never,
    res as never,
  );
  expect(status).toBe(409);
  expect(payload).toEqual({ message: expect.stringContaining('event management') });
});

it.each(['membership', 'read-access'])(
  'rechecks %s after waiting for the event lock',
  async (revocation) => {
    const { getDb } = await import('../../db/postgres');
    const { posts } = await import('../../db/schema/posts');
    const { eq, sql } = await import('drizzle-orm');
    const post = await insertPostRecord({
      oxyUserId: 'event-channel',
      authorship: [{ oxyUserId: 'event-channel', role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { event: { name: 'Race', date: new Date(Date.now() + 86400000).toISOString() } },
    });
    ids.push(post.id);
    state.readable = true;
    state.members = [{ memberUserId: 'operator', status: 'active' }];
    let release!: () => void;
    let signal!: (pid: number) => void;
    const ready = new Promise<number>((r) => (signal = r));
    const unblock = new Promise<void>((r) => (release = r));
    const holder = getDb().transaction(async (tx) => {
      await tx.select({ id: posts.id }).from(posts).where(eq(posts.id, post.id)).for('update');
      const [row] = await tx.execute(sql`select pg_backend_pid() as pid`);
      signal(Number(row.pid));
      await unblock;
    });
    const pid = await ready;
    const result = listEventAttendees(
      post.id,
      eventAccessFor(request('operator'), post.id),
      true,
    ).then(
      () => 200,
      (error) => error.status,
    );
    let waiting = false;
    try {
      for (let i = 0; i < 100; i++) {
        const [row] = await getDb().execute(
          sql`select exists(select 1 from pg_locks w join pg_locks h on w.transactionid = h.transactionid where not w.granted and h.granted and h.pid = ${pid}) as waiting`,
        );
        if (row.waiting) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      if (revocation === 'membership') state.members = [];
      else state.readable = false;
    } finally {
      release();
      await holder;
    }
    expect(await result).toBe(404);
  },
);
