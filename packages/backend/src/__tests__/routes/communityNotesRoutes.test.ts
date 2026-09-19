import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { CrowdSourceApiError } from '@oxy.so/crowdsource';

/**
 * `/community-notes`, as the app meets it.
 *
 * The CrowdSource side is mocked here on purpose: what this router decides is
 * not what a note IS — that is the service's, tested next door — but who may ask
 * for one and what a refusal looks like from the outside. Four of those
 * decisions are load-bearing:
 *
 *   * the session names the principal, never the body, or one caller could write
 *     notes as another;
 *   * an author does not annotate their own post;
 *   * a CrowdSource refusal reaches the reader as the thing it actually means
 *     ("you already rated this", "not found") rather than as a 500;
 *   * a drawn note whose post this viewer cannot see is dropped WITH the post.
 */

const service = vi.hoisted(() => ({
  communityNotesEnabled: vi.fn(() => true),
  writeCommunityNote: vi.fn(),
  withdrawCommunityNote: vi.fn(),
  rateCommunityNote: vi.fn(),
  drawCommunityNotesToRate: vi.fn(),
  communityNotesWrittenBy: vi.fn(),
  communityNotesRatedBy: vi.fn(),
}));

const posts = vi.hoisted(() => ({ loadPostRecords: vi.fn(), hydratePosts: vi.fn() }));

vi.mock('../../services/communityNotes/CommunityNotesService', async () => {
  const actual = await vi.importActual<typeof import('../../services/communityNotes/CommunityNotesService')>(
    '../../services/communityNotes/CommunityNotesService',
  );
  return { ...actual, ...service };
});

vi.mock('../../db/posts/postRepository', () => ({ loadPostRecords: posts.loadPostRecords }));
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: posts.hydratePosts },
}));
vi.mock('../../utils/oxyHelpers', () => ({ createScopedOxyClient: () => ({}) }));

import { CommunityNotesUnavailableError } from '../../services/communityNotes/CommunityNotesService';
import communityNotesRouter from '../../routes/communityNotes.routes';

const VIEWER_ID = 'viewer-1';

function appFor(viewerId: string | undefined) {
  const app = express();
  app.use(express.json());
  app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
    if (viewerId) req.user = { id: viewerId };
    next();
  });
  app.use('/community-notes', communityNotesRouter);
  return app;
}

const app = appFor(VIEWER_ID);
const anonymous = appFor(undefined);

const note = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  text: 'context',
  sourceUrls: [],
  status: 'shown',
  createdAt: '2026-09-18T00:00:00.000Z',
  ...over,
});

const postRecord = (authorId: string, over: Record<string, unknown> = {}) => ({
  id: 'p1',
  authorship: [{ oxyUserId: authorId, role: 'owner', status: 'accepted' }],
  status: 'published',
  visibility: 'public',
  ...over,
});

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockReset();
  service.communityNotesEnabled.mockReturnValue(true);
  posts.loadPostRecords.mockReset();
  posts.hydratePosts.mockReset();
  posts.hydratePosts.mockResolvedValue([{ id: 'p1' }]);
});

describe('availability', () => {
  it('reports whether this deployment takes notes', async () => {
    service.communityNotesEnabled.mockReturnValue(false);
    const res = await request(app).get('/community-notes/availability');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
  });
});

describe('writing a note', () => {
  it('sends the viewer as the writer and the post’s owner as the subject author', async () => {
    posts.loadPostRecords.mockResolvedValue([postRecord('author-1')]);
    service.writeCommunityNote.mockResolvedValue(note({ status: 'needs_ratings' }));

    const res = await request(app)
      .post('/community-notes')
      .set('Accept-Language', 'es-ES,es;q=0.9')
      .send({ postId: 'p1', text: '  context  ', sourceUrls: ['https://example.org/s'] });

    expect(res.status).toBe(201);
    expect(res.body.note.status).toBe('needs_ratings');
    expect(service.writeCommunityNote).toHaveBeenCalledWith({
      viewerId: VIEWER_ID,
      postId: 'p1',
      postAuthorId: 'author-1',
      language: 'es-ES',
      text: 'context',
      sourceUrls: ['https://example.org/s'],
    });
  });

  it('prefers the language the writer’s client declares over the request’s', async () => {
    posts.loadPostRecords.mockResolvedValue([postRecord('author-1')]);
    service.writeCommunityNote.mockResolvedValue(note());

    await request(app)
      .post('/community-notes')
      .set('Accept-Language', 'en')
      .send({ postId: 'p1', text: 'context', language: 'ca' });

    expect(service.writeCommunityNote.mock.calls[0]?.[0]).toMatchObject({ language: 'ca' });
  });

  it('refuses an author annotating their own post', async () => {
    posts.loadPostRecords.mockResolvedValue([postRecord(VIEWER_ID)]);

    const res = await request(app).post('/community-notes').send({ postId: 'p1', text: 'context' });

    expect(res.status).toBe(403);
    expect(service.writeCommunityNote).not.toHaveBeenCalled();
  });

  it('refuses a post with no resolvable author, which CrowdSource could not exclude', async () => {
    posts.loadPostRecords.mockResolvedValue([{ id: 'p1', authorship: [], status: 'published', visibility: 'public' }]);

    const res = await request(app).post('/community-notes').send({ postId: 'p1', text: 'context' });

    expect(res.status).toBe(409);
  });

  it.each([
    ['is not public', { visibility: 'followers_only' }],
    ['is not published yet', { status: 'draft' }],
  ])('refuses a post that %s, which raters could not read either', async (_label, over) => {
    posts.loadPostRecords.mockResolvedValue([postRecord('author-1', over)]);

    const res = await request(app).post('/community-notes').send({ postId: 'p1', text: 'context' });

    expect(res.status).toBe(403);
    expect(service.writeCommunityNote).not.toHaveBeenCalled();
  });

  it('refuses a public post this viewer is not allowed to see', async () => {
    posts.loadPostRecords.mockResolvedValue([postRecord('author-1')]);
    // What hydration answers for a reader the author blocked: nothing at all.
    posts.hydratePosts.mockResolvedValue([]);

    const res = await request(app).post('/community-notes').send({ postId: 'p1', text: 'context' });

    expect(res.status).toBe(404);
    expect(service.writeCommunityNote).not.toHaveBeenCalled();
  });

  it('answers 404 for a post that is not there', async () => {
    posts.loadPostRecords.mockResolvedValue([]);

    const res = await request(app).post('/community-notes').send({ postId: 'p1', text: 'context' });

    expect(res.status).toBe(404);
  });

  it.each([
    ['no text', { postId: 'p1', text: '   ' }],
    ['no post', { text: 'context' }],
    ['a body too long', { postId: 'p1', text: 'x'.repeat(501) }],
    ['a source that is not a URL', { postId: 'p1', text: 'context', sourceUrls: ['not-a-url'] }],
    ['more sources than a reader opens', {
      postId: 'p1',
      text: 'context',
      sourceUrls: ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example'],
    }],
  ])('refuses %s without asking CrowdSource', async (_label, body) => {
    const res = await request(app).post('/community-notes').send(body);
    expect(res.status).toBe(400);
    expect(posts.loadPostRecords).not.toHaveBeenCalled();
    expect(service.writeCommunityNote).not.toHaveBeenCalled();
  });

  it('refuses a caller with no session', async () => {
    const res = await request(anonymous).post('/community-notes').send({ postId: 'p1', text: 'context' });
    expect(res.status).toBe(401);
  });
});

describe('what a CrowdSource refusal looks like from outside', () => {
  const refuse = (status: number, code: Parameters<typeof CrowdSourceApiError>[0]['code'] = 'invalid_request') =>
    new CrowdSourceApiError({ status, code, message: 'refused' });

  beforeEach(() => {
    posts.loadPostRecords.mockResolvedValue([postRecord('author-1')]);
  });

  it.each([
    [404, 404],
    [409, 409],
    [429, 429],
    [422, 400],
    [400, 400],
    [500, 502],
    [503, 502],
  ])('turns a %i into a %i', async (from, expected) => {
    service.writeCommunityNote.mockRejectedValue(refuse(from));
    const res = await request(app).post('/community-notes').send({ postId: 'p1', text: 'context' });
    expect(res.status).toBe(expected);
  });

  it('says 503 when the integration is switched off, not 500', async () => {
    service.writeCommunityNote.mockRejectedValue(new CommunityNotesUnavailableError());
    const res = await request(app).post('/community-notes').send({ postId: 'p1', text: 'context' });
    expect(res.status).toBe(503);
  });

  it('says 502 when CrowdSource never answered at all', async () => {
    service.writeCommunityNote.mockRejectedValue(new Error('socket hang up'));
    const res = await request(app).post('/community-notes').send({ postId: 'p1', text: 'context' });
    expect(res.status).toBe(502);
  });
});

describe('withdrawing', () => {
  it('withdraws the viewer’s own note', async () => {
    service.withdrawCommunityNote.mockResolvedValue(note({ status: 'withdrawn' }));

    const res = await request(app).post('/community-notes/n1/withdraw');

    expect(res.status).toBe(200);
    expect(service.withdrawCommunityNote).toHaveBeenCalledWith(VIEWER_ID, 'n1');
    expect(res.body.note.status).toBe('withdrawn');
  });

  it('refuses a caller with no session', async () => {
    const res = await request(anonymous).post('/community-notes/n1/withdraw');
    expect(res.status).toBe(401);
    expect(service.withdrawCommunityNote).not.toHaveBeenCalled();
  });
});

describe('rating', () => {
  it('sends the rating with the reasons that explain it', async () => {
    service.rateCommunityNote.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/community-notes/n1/ratings')
      .send({ rating: 'helpful', reasons: ['relevant', 'reliable_source'] });

    expect(res.status).toBe(204);
    expect(service.rateCommunityNote).toHaveBeenCalledWith(VIEWER_ID, 'n1', {
      rating: 'helpful',
      reasons: ['relevant', 'reliable_source'],
    });
  });

  it.each([
    ['a reason from the other rating', { rating: 'helpful', reasons: ['incorrect'] }],
    ['no reason at all', { rating: 'not_helpful', reasons: [] }],
    ['a rating nobody offers', { rating: 'mixed', reasons: ['relevant'] }],
  ])('refuses %s', async (_label, body) => {
    const res = await request(app).post('/community-notes/n1/ratings').send(body);
    expect(res.status).toBe(400);
    expect(service.rateCommunityNote).not.toHaveBeenCalled();
  });

  it('refuses a caller with no session', async () => {
    const res = await request(anonymous).post('/community-notes/n1/ratings').send({ rating: 'helpful', reasons: ['relevant'] });
    expect(res.status).toBe(401);
  });
});

describe('the viewer’s lists', () => {
  it('draws a queue keyed to the hour, so reopening the hub re-reads it', async () => {
    service.drawCommunityNotesToRate.mockResolvedValue([
      { postId: 'p1', note: note(), expiresAt: '2026-09-19T00:00:00.000Z' },
    ]);

    const first = await request(app).post('/community-notes/to-rate').set('Accept-Language', 'ca');
    await request(app).post('/community-notes/to-rate').set('Accept-Language', 'ca');

    expect(first.status).toBe(200);
    expect(first.body.entries[0]).toMatchObject({ expiresAt: '2026-09-19T00:00:00.000Z' });
    expect(first.body.entries[0].post.id).toBe('p1');
    const [firstCall, secondCall] = service.drawCommunityNotesToRate.mock.calls;
    expect(firstCall?.[1]).toEqual(['ca']);
    expect(firstCall?.[2]).toBe(secondCall?.[2]);
    expect(firstCall?.[2]).toMatch(/^community-note-draw\.viewer-1\.\d{4}-\d{2}-\d{2}T\d{2}$/);
  });

  it('drops a note whose post this viewer cannot see', async () => {
    service.drawCommunityNotesToRate.mockResolvedValue([
      { postId: 'p1', note: note(), expiresAt: 'later' },
      { postId: 'hidden', note: note({ id: 'n2' }), expiresAt: 'later' },
    ]);

    const res = await request(app).post('/community-notes/to-rate');

    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].note.id).toBe('n1');
  });

  it('hydrates the posts of a whole list once', async () => {
    service.communityNotesWrittenBy.mockResolvedValue([
      { postId: 'p1', note: note() },
      { postId: 'p1', note: note({ id: 'n2' }) },
    ]);

    const res = await request(app).get('/community-notes/mine');

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(posts.hydratePosts).toHaveBeenCalledTimes(1);
    expect(posts.loadPostRecords).toHaveBeenCalledWith(['p1']);
  });

  it('asks for nothing when the viewer has rated nothing', async () => {
    service.communityNotesRatedBy.mockResolvedValue([]);

    const res = await request(app).get('/community-notes/ratings');

    expect(res.body).toEqual({ entries: [] });
    expect(posts.hydratePosts).not.toHaveBeenCalled();
  });

  it('refuses a caller with no session', async () => {
    expect((await request(anonymous).get('/community-notes/mine')).status).toBe(401);
    expect((await request(anonymous).get('/community-notes/ratings')).status).toBe(401);
    expect((await request(anonymous).post('/community-notes/to-rate')).status).toBe(401);
  });
});
