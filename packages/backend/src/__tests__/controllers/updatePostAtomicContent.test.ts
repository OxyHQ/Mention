/** Actual controller + PostgreSQL: a claim sees one committed native revision. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

const hoisted = vi.hoisted(() => ({
  hydratePosts: vi.fn(),
  createScopedOxyClient: vi.fn(),
  resolveCollaboratorRefs: vi.fn(),
  emitPostCreated: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: hoisted.createScopedOxyClient,
  createUserScopedOxyServices: vi.fn(() => undefined),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: hoisted.hydratePosts },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: (id: string) => ({
    id,
    username: '',
    name: { displayName: 'Unknown user' },
  }),
}));

vi.mock('../../services/PostCollaborationService', () => ({
  postCollaborationService: {
    resolveCollaboratorRefs: hoisted.resolveCollaboratorRefs,
    attachCollaborators: vi.fn(),
    autoAcceptInvites: vi.fn(),
    notifyPendingInvites: vi.fn(),
  },
  CollabValidationError: class extends Error {},
  CollabStateError: class extends Error {},
}));

vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: hoisted.emitPostCreated,
  emitTombstone: vi.fn(),
  postRecordUri: () => 'at://test',
}));

import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { lockPostContent } from '../../db/posts/postRepository';
import { claimPostEvaluation } from '../../db/posts/postEvaluationRepository';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { updatePost } from '../../controllers/posts/updatePost';
const scope = serviceScope('atomic-native-edit');
const USER_ID = scope.user('author');
let id = '';
const oldText = 'Synthetic English science news.';
const newText = 'Les nouvelles scientifiques françaises.';
const release = {
  model: 'synthetic/jev@fixture-v1',
  policyRef: 'fixture-policy',
  policyVersion: 1,
  evaluationVersion: 'atomic-edit-v1',
  supportedLanguages: ['en', 'fr'],
};
function barrier() {
  let open!: () => void;
  const reached = new Promise<void>((r) => {
    open = r;
  });
  return { open, reached };
}
async function holdContent() {
  const ready = barrier();
  const done = barrier();
  const pending = getDb().transaction(async (tx) => {
    await lockPostContent(tx, id);
    ready.open();
    await done.reached;
  });
  await ready.reached;
  return async () => {
    done.open();
    await pending;
  };
}
async function waiters(n: number) {
  await vi.waitFor(
    async () => {
      const [row] = await getDb().execute<{
        waiting: number;
      }>(sql`select count(*)::int as waiting from pg_locks
      where locktype='advisory' and not granted
      and ((classid::bigint << 32) | objid::bigint)=hashtext(${`post-content:${id}`})::bigint`);
      expect(row?.waiting).toBe(n);
    },
    { timeout: 5000, interval: 10 },
  );
}
async function edit(text = newText) {
  let status = 200;
  const req = {
    params: { id },
    query: {},
    headers: {},
    acceptsLanguages: () => [],
    user: { id: USER_ID },
    body: { content: { variants: [{ source: 'author', tag: 'fr', text }] } },
  };
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  };
  await updatePost(req as never, res as never);
  return status;
}
beforeAll(() => connectPostgres());
afterAll(() => closePostgres());
beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.createScopedOxyClient.mockReturnValue(undefined);
  hoisted.hydratePosts.mockImplementation(async () => [{ id }]);
  hoisted.resolveCollaboratorRefs.mockResolvedValue(undefined);
  const post = await seedPost(scope, {
    oxyUserId: USER_ID,
    status: 'published',
    createdAt: new Date(),
    language: 'en',
    content: { variants: [{ source: 'author', tag: 'en', text: oldText }] },
  });
  id = post.id;
  await getDb()
    .update(posts)
    .set({ classificationLanguages: ['en'] })
    .where(eq(posts.id, id));
});
afterEach(() => clearServiceScope(scope));
describe('native author edit is one content revision', () => {
  it('does not admit new languages with the previous body while an edit waits for the content lock', async () => {
    const unlock = await holdContent();
    const claim = claimPostEvaluation(id, release);
    let updating: Promise<number> | undefined;
    try {
      await waiters(1);
      updating = edit();
      await waiters(2);
    } finally {
      await unlock();
    }
    const [claimed, status] = await Promise.all([claim, updating]);
    expect(status).toBe(200);
    expect(claimed).not.toBeNull();
    expect(claimed?.snapshot.languages).toEqual(['en']);
    expect(claimed?.snapshot.renditions[0]?.body).toBe(oldText);
    const after = await readPost(id);
    expect(after?.language).toBe('fr');
    expect(after?.content.variants[0]?.text).toBe(newText);
  });
  it('rolls scalar language and classification back when the content insert fails', async () => {
    const before = await readPost(id);
    await getDb().execute(
      sql.raw(`create function atomic_edit_reject() returns trigger language plpgsql as $$ begin
      if NEW.body = 'atomic-fixture-reject' then raise exception 'owned fixture content rejection'; end if;
      return NEW; end $$`),
    );
    await getDb().execute(
      sql.raw(
        'create trigger atomic_edit_reject before insert on post_content_variants for each row execute function atomic_edit_reject()',
      ),
    );
    let status: number;
    try {
      status = await edit('atomic-fixture-reject');
    } finally {
      await getDb().execute(sql.raw('drop trigger atomic_edit_reject on post_content_variants'));
      await getDb().execute(sql.raw('drop function atomic_edit_reject()'));
    }
    expect(status).toBe(500);
    const after = await readPost(id);
    expect(after?.language).toBe(before?.language);
    expect(after?.postClassification).toEqual(before?.postClassification);
    expect(after?.content).toEqual(before?.content);
  });
  it('rechecks an unpublished carve-out after acquiring the content lock', async () => {
    await getDb()
      .update(posts)
      .set({ status: 'draft', createdAt: new Date(Date.now() - 86400000) })
      .where(eq(posts.id, id));
    const unlock = await holdContent();
    const updating = edit();
    try {
      await waiters(1);
      await getDb().update(posts).set({ status: 'published' }).where(eq(posts.id, id));
    } finally {
      await unlock();
    }
    expect(await updating).toBe(409);
    const after = await readPost(id);
    expect(after?.status).toBe('published');
    expect(after?.language).toBe('en');
    expect(after?.content.variants[0]?.text).toBe(oldText);
  });
});
