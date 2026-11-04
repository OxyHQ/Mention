import { Readable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signedFetch: vi.fn(),
  safeFetch: vi.fn(),
  findActorByUri: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/helpers', async (importActual) => ({
  ...(await importActual<typeof import('../../../connectors/activitypub/helpers')>()),
  signedFetch: mocks.signedFetch,
}));
vi.mock('@oxy.so/core/server', async (importActual) => ({
  ...(await importActual<typeof import('@oxy.so/core/server')>()),
  safeFetch: mocks.safeFetch,
}));
// No Redis: every throttle and NodeInfo read is a miss, so each case starts clean.
vi.mock('../../../utils/cache', () => ({
  createCache: () => ({
    has: async () => false,
    set: async () => undefined,
    getOrCompute: (_key: string, compute: () => Promise<unknown>) => compute(),
  }),
}));
vi.mock('../../../db/federation/actorRepository', async (importActual) => ({
  ...(await importActual<typeof import('../../../db/federation/actorRepository')>()),
  findActorByUri: mocks.findActorByUri,
}));
vi.mock('../../../db/posts/postRepository', async (importActual) => ({
  ...(await importActual<typeof import('../../../db/posts/postRepository')>()),
  findPostRecords: async () => [],
}));
vi.mock('../../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { outboxSyncService } from '../../../connectors/activitypub/outbox.service';
import connectorsRoutes from '../../../connectors/connectors.routes';

/** A profile's outbox is empty; its server may still list the public statuses. */
const emptyOutbox = {
  ok: true,
  status: 200,
  json: async () => ({ type: 'OrderedCollection', totalItems: 0, orderedItems: [] }),
};

function serve(routes: Record<string, unknown>) {
  mocks.safeFetch.mockImplementation(async (url: string) => {
    const { origin, pathname } = new URL(url);
    const body = routes[`${origin}${pathname}`];
    const status = body === undefined ? 404 : 200;
    return {
      status,
      headers: {},
      finalUrl: url,
      response: Readable.from([
        Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? {})),
      ]),
    };
  });
}

function nodeinfo(origin: string, software: string) {
  return {
    [`${origin}/.well-known/nodeinfo`]: {
      links: [
        { rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0', href: `${origin}/nodeinfo/2.0` },
      ],
    },
    [`${origin}/nodeinfo/2.0`]: { software: { name: software } },
  };
}

/** A Mastodon server listing `alice`'s statuses: one public, one private, one unlisted, one boost. */
function mastodonServer(origin: string) {
  const actorUri = `${origin}/users/alice`;
  const status = (id: string, visibility: string, extra: object = {}) => ({
    id,
    visibility,
    uri: `${actorUri}/statuses/${id}`,
    ...extra,
  });
  serve({
    ...nodeinfo(origin, 'mastodon'),
    [`${origin}/api/v1/accounts/lookup`]: { id: '7', username: 'alice', uri: actorUri },
    [`${origin}/api/v1/accounts/7/statuses`]: [
      status('3', 'public'),
      status('2', 'private'),
      status('1', 'unlisted'),
      status('0', 'public', { reblog: { id: '9' } }),
    ],
  });
  return actorUri;
}

function actorRow(actorUri: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'actor-row',
    protocol: 'activitypub',
    uri: actorUri,
    username: actorUri.split('/').at(-1),
    acct: `${actorUri.split('/').at(-1)}@${new URL(actorUri).host}`,
    outboxUrl: `${actorUri}/outbox`,
    oxyUserId: 'oxy-user',
    outboxBackfill: {},
    ...overrides,
  };
}

const ensureFederatedNote = () =>
  vi
    .spyOn(
      outboxSyncService as unknown as {
        ensureFederatedNote: (uri: string) => Promise<string | null>;
      },
      'ensureFederatedNote',
    )
    .mockImplementation(async (uri) => `post:${uri}`);

const options = { limit: 20, importReason: 'requested_profile' } as const;

afterEach(() => {
  vi.restoreAllMocks();
  mocks.safeFetch.mockReset();
  mocks.signedFetch.mockReset();
  mocks.findActorByUri.mockReset();
});

describe('the public statuses fallback of a profile outbox sync', () => {
  it("imports a Mastodon account's public statuses through the verified note path", async () => {
    const actorUri = mastodonServer('https://mastodon.example');
    mocks.signedFetch.mockResolvedValue(emptyOutbox);
    const ensure = ensureFederatedNote();

    const result = await outboxSyncService.syncProfileOutbox(actorRow(actorUri) as never, options);

    expect(ensure.mock.calls.map(([uri]) => uri)).toEqual([
      `${actorUri}/statuses/3`,
      `${actorUri}/statuses/1`,
    ]);
    expect(result).toMatchObject({ syncedCount: 2, publicStatusesSyncedCount: 2 });
  });

  it('never calls the API of a server that is not Mastodon-compatible', async () => {
    const origin = 'https://other.example';
    serve(nodeinfo(origin, 'pleroma'));
    mocks.signedFetch.mockResolvedValue(emptyOutbox);
    const ensure = ensureFederatedNote();

    const result = await outboxSyncService.syncProfileOutbox(
      actorRow(`${origin}/users/bob`) as never,
      options,
    );

    const requested = mocks.safeFetch.mock.calls.map(([url]) => new URL(url as string).pathname);
    expect(requested.some((path) => path.startsWith('/api/'))).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
    expect(result.syncedCount).toBe(0);
  });
});

describe('GET /federation/actor/posts for an outbox marked unavailable', () => {
  it('skips the outbox but still tries the public statuses, like the profile sync', async () => {
    const actorUri = mastodonServer('https://locked.example');
    const outboxUrl = `${actorUri}/outbox`;
    mocks.findActorByUri.mockResolvedValue(
      actorRow(actorUri, { outboxBackfill: { status: 'unavailable', outboxUrl } }),
    );
    const ensure = ensureFederatedNote();
    const app = express().use('/federation', connectorsRoutes);

    const res = await request(app).get('/federation/actor/posts').query({ uri: actorUri });

    expect(res.body).toMatchObject({ posts: [], syncing: false, syncUnavailable: true });
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(2));
    expect(mocks.signedFetch).not.toHaveBeenCalled();
  });
});
