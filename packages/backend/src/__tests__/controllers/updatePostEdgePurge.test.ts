import { adultSafetyFixture } from '../helpers/adultSafety';
/**
 * A native edit of a public, published post purges its page from Cloudflare's
 * edge; an edit of a draft, which has no public page, does not. Actual
 * controller and PostgreSQL, with the purge as the seam.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

const hoisted = vi.hoisted(() => ({
  hydratePosts: vi.fn(),
  purgePostPages: vi.fn(),
}));

vi.mock('../../services/webshell/postPageEdgePurge', () => ({
  purgePostPages: hoisted.purgePostPages,
}));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ safety: adultSafetyFixture() }),
  createScopedOxyClient: vi.fn(() => undefined),
  callerOxyUser: vi.fn(() => undefined),
  callerAccountAccess: vi.fn(() => undefined),
}));
vi.mock('../../services/posts/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: hoisted.hydratePosts },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: (id: string) => ({
    id,
    username: '',
    name: { displayName: 'Unknown user' },
  }),
}));
vi.mock('../../services/posts/PostCollaborationService', () => ({
  postCollaborationService: {
    resolveCollaboratorRefs: vi.fn(async () => undefined),
    attachCollaborators: vi.fn(),
    autoAcceptInvites: vi.fn(),
    notifyPendingInvites: vi.fn(),
  },
  CollabValidationError: class extends Error {},
  CollabStateError: class extends Error {},
}));
vi.mock('../../connectors/outboundFederation', () => ({ federateAsResolvedActor: vi.fn() }));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { updatePost } from '../../controllers/posts/updatePost';

const scope = serviceScope('edit-edge-purge');
const USER_ID = scope.user('author');

async function edit(id: string, text: string): Promise<number> {
  let status = 200;
  const req = {
    accessToken: 'test-viewer-session',
    params: { id },
    query: {},
    headers: {},
    acceptsLanguages: () => [],
    user: { id: USER_ID },
    body: { content: { variants: [{ source: 'author', tag: 'en', text }] } },
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
beforeEach(() => {
  vi.clearAllMocks();
  hoisted.purgePostPages.mockResolvedValue(undefined);
  hoisted.hydratePosts.mockImplementation(async (records: Array<{ id: string }>) =>
    records.map((record) => ({ id: record.id })),
  );
});
afterEach(() => clearServiceScope(scope));

describe('a native edit', () => {
  it('purges the page of a public, published post', async () => {
    const post = await seedPost(scope, { oxyUserId: USER_ID, createdAt: new Date() });

    expect(await edit(post.id, 'The corrected text.')).toBe(200);
    expect(hoisted.purgePostPages).toHaveBeenCalledWith([post.id], 'edit');
  });

  it('does not purge a draft, which has no public page', async () => {
    const draft = await seedPost(scope, {
      oxyUserId: USER_ID,
      status: 'draft',
      createdAt: new Date(),
    });

    expect(await edit(draft.id, 'Still drafting.')).toBe(200);
    expect(hoisted.purgePostPages).not.toHaveBeenCalled();
  });
});
