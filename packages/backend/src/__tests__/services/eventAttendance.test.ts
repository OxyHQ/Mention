import { deletePostSubtree } from '../../services/PostDeletionCascade';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { connectPostgres, closePostgres, getDb } from '../../db/postgres';
import {
  insertPostRecord,
  loadPostRecord,
  replacePostContent,
  deletePostRecord,
} from '../../db/posts/postRepository';
import { posts } from '../../db/schema/posts';
import { eventAttendance } from '../../db/schema/events';
import { notifications } from '../../db/schema/discovery';
import {
  cancelEventAttendance,
  editEvent,
  getEventState,
  listEventAttendees,
  registerForEvent,
  type EventAccess,
} from '../../services/EventAttendanceService';
import { EventRegistration } from '@oxy.so/mention-contracts';
import { sanitizeEventData } from '../../controllers/posts/composeInput';
import { adultSafetyFixture } from '../helpers/adultSafety';
vi.mock('../../utils/oxyHelpers', async (original) => ({
  ...(await original<typeof import('../../utils/oxyHelpers')>()),
  getServiceOxyClient: () => ({ safety: adultSafetyFixture() }),
}));
vi.mock('../../utils/notificationUtils', async (original) => ({
  ...(await original<typeof import('../../utils/notificationUtils')>()),
  deliverEventNotifications: vi.fn(async () => {}),
}));
const ids: string[] = [];
const future = () => new Date(Date.now() + 86400000).toISOString();
const access = (viewerId: string, manage = false, read = true): EventAccess => ({
  viewerId,
  read: async () => read,
  manage: async () => manage,
});
const owner = access('event-test-owner', true);
async function fixture(capacity: number | null = 1, homiio = false) {
  const post = await insertPostRecord({
    oxyUserId: owner.viewerId,
    authorship: [{ oxyUserId: owner.viewerId, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: {
      event: { name: 'Meeting', date: future(), capacity },
      ...(homiio ? { homiioCase: { caseId: 'foreign-case' } } : {}),
    },
  });
  ids.push(post.id);
  return post;
}
beforeAll(connectPostgres);
afterAll(async () => {
  for (const id of ids) {
    await getDb().delete(notifications).where(eq(notifications.entityId, id));
    await deletePostRecord(id, undefined);
  }
  await closePostgres();
});
it('private by default, public opt-in, organizer-only full roster and viewer-specific participation', async () => {
  const post = await fixture(null);
  expect(EventRegistration.parse({})).toEqual({ public: false });
  await registerForEvent(post.id, access('private'), false);
  await registerForEvent(post.id, access('public'), true);
  expect((await listEventAttendees(post.id, access(''), false)).items).toEqual([
    { oxyUserId: 'public', public: true },
  ]);
  expect((await listEventAttendees(post.id, owner, true)).items).toHaveLength(2);
  await expect(listEventAttendees(post.id, access('stranger'), true)).rejects.toMatchObject({
    status: 404,
  });
  expect((await getEventState(post.id, access('private'))).viewerAttendance).toEqual({
    public: false,
  });
  expect((await getEventState(post.id, access('stranger'))).viewerAttendance).toBeNull();
});
it('capacity race, duplicate retries and cancellation releasing the seat', async () => {
  const post = await fixture();
  const results = await Promise.allSettled([
    registerForEvent(post.id, access('a'), false),
    registerForEvent(post.id, access('b'), false),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const [winner] = await getDb()
    .select()
    .from(eventAttendance)
    .where(eq(eventAttendance.postId, post.id));
  await registerForEvent(post.id, access(winner.oxyUserId), false);
  expect((await getEventState(post.id, owner)).attendingCount).toBe(1);
  await cancelEventAttendance(post.id, access(winner.oxyUserId));
  await cancelEventAttendance(post.id, access(winner.oxyUserId));
  expect((await registerForEvent(post.id, access('next'), false)).attendingCount).toBe(1);
});
it('demonstrates a real parent lock wait and recounts seats committed during the wait', async () => {
  const post = await fixture();
  let release!: () => void;
  let signal!: (pid: number) => void;
  const ready = new Promise<number>((r) => (signal = r));
  const unblock = new Promise<void>((r) => (release = r));
  const holder = getDb().transaction(async (tx) => {
    await tx.select({ id: posts.id }).from(posts).where(eq(posts.id, post.id)).for('update');
    const [row] = await tx.execute(sql`select pg_backend_pid() as pid`);
    signal(Number(row.pid));
    await unblock;
    await tx.insert(eventAttendance).values({ postId: post.id, oxyUserId: 'holder' });
  });
  const pid = await ready;
  const contender = registerForEvent(post.id, access('waiter'), false).then(
    () => 'unexpected',
    (e) => e.code,
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
  } finally {
    release();
    await holder;
  }
  expect(await contender).toBe('conflict');
});
it('edits notify, lost-response retries do not refresh read notices, cancel is permanent and retry-safe', async () => {
  const post = await fixture(null);
  await registerForEvent(post.id, access('attendee'), false);
  const current = await getEventState(post.id, owner);
  const change = { name: 'Changed', date: current.date, capacity: null, revision: 0 };
  expect((await editEvent(post.id, owner, change)).revision).toBe(1);
  const [notice] = await getDb()
    .select()
    .from(notifications)
    .where(eq(notifications.entityId, post.id));
  expect(notice.type).toBe('event_updated');
  expect(notice.recipientId).toBe('attendee');
  await getDb().update(notifications).set({ read: true }).where(eq(notifications.id, notice.id));
  await editEvent(post.id, owner, change);
  expect(
    (await getDb().select().from(notifications).where(eq(notifications.id, notice.id)))[0].read,
  ).toBe(true);
  await expect(editEvent(post.id, owner, { ...change, name: 'Stale' })).rejects.toMatchObject({
    status: 409,
  });
  await editEvent(post.id, owner, { cancelled: true, revision: 1 });
  await editEvent(post.id, owner, { cancelled: true, revision: 1 });
  expect(
    (await getDb().select().from(notifications).where(eq(notifications.entityId, post.id)))
      .map((n) => n.type)
      .sort(),
  ).toEqual(['event_cancelled', 'event_updated']);
  await expect(registerForEvent(post.id, access('late'), false)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    editEvent(post.id, owner, { ...change, revision: 2, name: 'Reopen' }),
  ).rejects.toMatchObject({ status: 409 });
});
it('cannot reduce capacity below existing attendance', async () => {
  const post = await fixture(2);
  await registerForEvent(post.id, access('one'), false);
  await registerForEvent(post.id, access('two'), false);
  const initial = await getEventState(post.id, owner);
  await expect(
    editEvent(post.id, owner, { name: initial.name, date: initial.date, capacity: 1, revision: 0 }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (
      await editEvent(post.id, owner, {
        name: initial.name,
        date: initial.date,
        capacity: null,
        revision: 0,
      })
    ).capacity,
  ).toBeNull();
});
it('rejects Homiio, revoked visibility, drafts and past events; withdrawal works after revocation', async () => {
  const foreign = await fixture(null, true);
  await expect(registerForEvent(foreign.id, owner, false)).rejects.toMatchObject({ status: 404 });
  const post = await fixture();
  await registerForEvent(post.id, access('member'), false);
  await expect(getEventState(post.id, access('member', false, false))).rejects.toMatchObject({
    status: 404,
  });
  await cancelEventAttendance(post.id, access('member', false, false));
  expect((await getEventState(post.id, owner)).attendingCount).toBe(0);
  await getDb().update(posts).set({ status: 'draft' }).where(eq(posts.id, post.id));
  await expect(registerForEvent(post.id, owner, false)).rejects.toMatchObject({ status: 404 });
  await getDb()
    .update(posts)
    .set({ status: 'published', contentEventDate: new Date(Date.now() - 1000) })
    .where(eq(posts.id, post.id));
  await expect(registerForEvent(post.id, owner, false)).rejects.toMatchObject({ status: 409 });
});
it('generic replacement cannot overwrite event state or attach Homiio to bypass participation', async () => {
  const post = await fixture(3);
  const stale = await loadPostRecord(post.id);
  const initial = await getEventState(post.id, owner);
  await editEvent(post.id, owner, {
    name: 'Current',
    date: initial.date,
    capacity: 2,
    revision: 0,
  });
  await replacePostContent(
    post.id,
    {
      ...stale!.content,
      event: { name: 'Bypass', date: future(), capacity: 1 },
      homiioCase: { caseId: 'bad' },
      variants: [{ text: 'https://homiio.com/cases/bad', source: 'author' }],
    },
    [],
  );
  const actual = await loadPostRecord(post.id);
  expect(actual?.content.event?.name).toBe('Current');
  expect(actual?.content.event?.capacity).toBe(2);
  expect(actual?.content.homiioCase).toBeUndefined();
  expect((await getEventState(post.id, owner)).revision).toBe(1);
});
it('creation validates capacity and ignores forged revision/cancellation', () => {
  expect(sanitizeEventData({ name: 'A', date: future(), capacity: 0 })).toBeNull();
  expect(sanitizeEventData({ name: 'A', date: future(), capacity: -1 })).toBeNull();
  expect(
    sanitizeEventData({ name: 'A', date: future(), capacity: 2, cancelled: true, revision: 99 }),
  ).toMatchObject({ capacity: 2 });
  expect(sanitizeEventData({ name: 'A', date: future(), cancelled: true })).not.toHaveProperty(
    'cancelled',
  );
});
it('notification failure rolls back the event revision and changed facts', async () => {
  const post = await fixture(null);
  await registerForEvent(post.id, access('rollback-person'), false);
  const before = await getEventState(post.id, owner);
  await getDb().execute(
    sql`create function test_event_notice_fail() returns trigger language plpgsql as $$ begin if new.recipient_id = 'rollback-person' then raise exception 'test reject'; end if; return new; end $$`,
  );
  await getDb().execute(
    sql`create trigger test_event_notice_fail before insert on notifications for each row execute function test_event_notice_fail()`,
  );
  try {
    await expect(
      editEvent(post.id, owner, {
        name: 'Never committed',
        date: before.date,
        capacity: null,
        revision: 0,
      }),
    ).rejects.toThrow();
  } finally {
    await getDb().execute(sql`drop trigger test_event_notice_fail on notifications`);
    await getDb().execute(sql`drop function test_event_notice_fail()`);
  }
  expect((await getEventState(post.id, owner)).name).toBe(before.name);
  expect((await getEventState(post.id, owner)).revision).toBe(0);
});

it('ordinary deletion requires cancellation, then retains the minimal durable notice', async () => {
  const post = await fixture(null);
  await registerForEvent(post.id, access('delete-attendee'), false);
  await expect(
    deletePostSubtree(post.id, eq(posts.oxyUserId, owner.viewerId)),
  ).rejects.toMatchObject({
    name: 'Error',
    message: expect.stringContaining('Cancel attended events'),
  });
  expect(await loadPostRecord(post.id)).not.toBeNull();
  await editEvent(post.id, owner, { cancelled: true, revision: 0 });
  await deletePostSubtree(post.id, eq(posts.oxyUserId, owner.viewerId));
  expect(await loadPostRecord(post.id)).toBeNull();
  const notices = await getDb()
    .select()
    .from(notifications)
    .where(eq(notifications.entityId, post.id));
  expect(notices).toHaveLength(1);
  expect(notices[0].type).toBe('event_cancelled');
  expect(notices[0].recipientId).toBe('delete-attendee');
  expect(
    await getDb().select().from(eventAttendance).where(eq(eventAttendance.postId, post.id)),
  ).toHaveLength(0);
});
it('thread deletion cannot bypass an attended child event; privileged removals remain possible', async () => {
  const root = await fixture(null);
  const child = await fixture(null);
  await getDb()
    .update(posts)
    .set({ parentPostId: root.id, isReply: true })
    .where(eq(posts.id, child.id));
  await registerForEvent(child.id, access('child-attendee'), false);
  await expect(deletePostSubtree(root.id, eq(posts.oxyUserId, owner.viewerId))).rejects.toThrow(
    'Cancel attended events',
  );
  expect(await loadPostRecord(child.id)).not.toBeNull();
  await deletePostSubtree(root.id, eq(posts.oxyUserId, owner.viewerId), 'privileged-removal');
  expect(await loadPostRecord(root.id)).toBeNull();
  expect(await loadPostRecord(child.id)).toBeNull();
});

it('ACL reads see local profile privacy inside the supplied transaction', async () => {
  const { postHydrationService } = await import('../../services/PostHydrationService');
  const { userSettings } = await import('../../db/schema/userProfile');
  const post = await fixture();
  expect(await postHydrationService.canViewerReadPostId(post.id, '')).toBe(true);
  await getDb().transaction(async (tx) => {
    await tx
      .insert(userSettings)
      .values({ oxyUserId: owner.viewerId, privacyProfileVisibility: 'private' })
      .onConflictDoUpdate({
        target: userSettings.oxyUserId,
        set: { privacyProfileVisibility: 'private' },
      });
    expect(await postHydrationService.canViewerReadPostId(post.id, '', undefined, tx)).toBe(false);
    await tx.delete(userSettings).where(eq(userSettings.oxyUserId, owner.viewerId));
  });
});
it('existing attendees can hide public attendance after the event closes', async () => {
  const post = await fixture();
  await registerForEvent(post.id, access('privacy-after-close'), true);
  await getDb()
    .update(posts)
    .set({ contentEventDate: new Date(0) })
    .where(eq(posts.id, post.id));
  expect(
    (await registerForEvent(post.id, access('privacy-after-close'), false)).viewerAttendance,
  ).toEqual({ public: false });
  expect((await listEventAttendees(post.id, access(''), false)).items).toEqual([]);
  await expect(registerForEvent(post.id, access('new'), false)).rejects.toMatchObject({
    status: 409,
  });
});
