import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ signedFetch: vi.fn(), safeFetch: vi.fn() }));

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

import { outboxSyncService } from '../../../connectors/activitypub/outbox.service';

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

const ensureFederatedNote = () =>
  vi
    .spyOn(
      outboxSyncService as unknown as {
        ensureFederatedNote: (uri: string) => Promise<string | null>;
      },
      'ensureFederatedNote',
    )
    .mockImplementation(async (uri) => `post:${uri}`);

afterEach(() => {
  vi.restoreAllMocks();
  mocks.safeFetch.mockReset();
  mocks.signedFetch.mockReset();
});

describe('the public statuses fallback of a profile outbox sync', () => {
  it("imports a Mastodon account's public statuses through the verified note path", async () => {
    const origin = 'https://mastodon.example';
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
    mocks.signedFetch.mockResolvedValue(emptyOutbox);
    const ensure = ensureFederatedNote();

    const result = await outboxSyncService.syncOutboxPostsDetailed(
      {
        uri: actorUri,
        acct: 'alice@mastodon.example',
        username: 'alice',
        outboxUrl: `${actorUri}/outbox`,
      },
      { limit: 20, importReason: 'requested_profile', publicStatusesFallback: true },
    );

    expect(ensure.mock.calls.map(([uri]) => uri)).toEqual([
      `${actorUri}/statuses/3`,
      `${actorUri}/statuses/1`,
    ]);
    expect(result).toMatchObject({ syncedCount: 2, publicStatusesSyncedCount: 2 });
  });

  it('never calls the API of a server that is not Mastodon-compatible', async () => {
    const origin = 'https://other.example';
    const actorUri = `${origin}/users/bob`;
    serve(nodeinfo(origin, 'pleroma'));
    mocks.signedFetch.mockResolvedValue(emptyOutbox);
    const ensure = ensureFederatedNote();

    const result = await outboxSyncService.syncOutboxPostsDetailed(
      {
        uri: actorUri,
        acct: 'bob@other.example',
        username: 'bob',
        outboxUrl: `${actorUri}/outbox`,
      },
      { limit: 20, importReason: 'requested_profile', publicStatusesFallback: true },
    );

    const requested = mocks.safeFetch.mock.calls.map(([url]) => new URL(url as string).pathname);
    expect(requested.some((path) => path.startsWith('/api/'))).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
    expect(result.syncedCount).toBe(0);
  });
});
