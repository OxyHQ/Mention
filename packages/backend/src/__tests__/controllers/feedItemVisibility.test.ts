import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  loadPost: vi.fn(),
}));

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));
vi.mock('../../services/postDetailCache', () => ({
  getOrLoadPostRecord: (id: string) => hoisted.loadPost(id),
}));
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => undefined),
  createUserScopedOxyServices: vi.fn(() => undefined),
}));
vi.mock('../../utils/privacyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/privacyHelpers')>()),
  resolveViewerPrivacyAndGraph: vi.fn(async () => undefined),
}));

import { feedController } from '../../controllers/feed.controller';
import { postHydrationService } from '../../services/PostHydrationService';

function request(id: string) {
  return { params: { id }, user: undefined, query: {}, headers: {}, acceptsLanguages: () => [] as string[] };
}

function response() {
  const res = { statusCode: 200, body: undefined as unknown, headersSent: false } as {
    statusCode: number; body: unknown; status: (c: number) => typeof res; json: (b: unknown) => typeof res;
  };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

describe('GET /feed/item/:id visibility', () => {
  beforeEach(() => {
    hoisted.loadPost.mockReset();
  });

  it('answers 404, never an empty 200, for a post the viewer may not read', async () => {
    hoisted.loadPost.mockResolvedValue({ id: 'draft-1', status: 'draft' });
    vi.spyOn(feedController, 'transformPostsWithProfiles' as never).mockResolvedValue([] as never);
    const res = response();
    await feedController.getFeedItemById(request('draft-1') as never, res as never);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Post not found' });
  });

  it('answers the same 404 for a post that does not exist, so the two cannot be told apart', async () => {
    hoisted.loadPost.mockResolvedValue(null);
    const res = response();
    await feedController.getFeedItemById(request('missing') as never, res as never);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Post not found' });
  });

  it('still answers the hydrated post when the viewer may read it', async () => {
    hoisted.loadPost.mockResolvedValue({ id: 'p-1', status: 'published' });
    vi.spyOn(feedController, 'transformPostsWithProfiles' as never).mockResolvedValue([{ id: 'p-1' }] as never);
    const res = response();
    await feedController.getFeedItemById(request('p-1') as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ id: 'p-1' });
  });

  it('answers 500, not 404, when hydrating a readable post fails', async () => {
    hoisted.loadPost.mockResolvedValue({ id: 'p-2', status: 'published' });
    vi.restoreAllMocks();
    vi.spyOn(postHydrationService, 'hydratePosts').mockRejectedValue(new Error('quote count query failed'));
    const res = response();
    await feedController.getFeedItemById(request('p-2') as never, res as never);
    expect(res.statusCode).toBe(500);
  });

  it('still answers the lists timeline with an empty page when hydration fails, as before', async () => {
    vi.restoreAllMocks();
    vi.spyOn(postHydrationService, 'hydratePosts').mockRejectedValue(new Error('boom'));
    await expect(feedController.transformPostsWithProfiles([{ id: 'x' }])).resolves.toEqual([]);
  });
});
