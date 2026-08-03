import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PASTING A PROFILE LINK, ALL THE WAY THROUGH.
 *
 * Every other test on this path stops at a seam: the route tests hand the lane a
 * pre-normalized actor, and the ingest tests stop at the identity bridge. Both
 * passed while the reader still saw `@elonmusk@bird.makeup`, because the bug was
 * in neither half — it was in the AGREEMENT between them. The ingest stored the
 * account under `elonmusk@x.com` and the route answered with the bridge address
 * for the same actor, and no test looked at both.
 *
 * So this one runs the whole lane against the actor document `bird.makeup`
 * actually serves: URL → derived bridge acct → WebFinger → actor fetch → re-label
 * → the identity Oxy is asked to store → the response the client renders. Only
 * the network, Mongo and the Oxy service client are stubbed; the bridge policy,
 * the connector registry and the resolver are the real ones.
 *
 * Captured live from `https://bird.makeup/users/elonmusk` on 2026-08-03 with
 * `Accept: application/activity+json`; only the fields the ingest reads are kept.
 */

const { WEBFINGER_JRD } = vi.hoisted(() => ({
  WEBFINGER_JRD: {
    subject: 'acct:elonmusk@bird.makeup',
    links: [{ rel: 'self', type: 'application/activity+json', href: 'https://bird.makeup/users/elonmusk' }],
  },
}));

const mocks = vi.hoisted(() => ({
  signedFetch: vi.fn(),
  actorFindOne: vi.fn(),
  actorFindOneAndUpdate: vi.fn(),
  makeServiceRequest: vi.fn(),
}));

// The signed AP fetch is the only thing replaced in `helpers` — acct
// normalization and domain parsing are part of what is under test.
vi.mock('../../connectors/activitypub/helpers', async () => {
  const actual = await vi.importActual<typeof import('../../connectors/activitypub/helpers')>(
    '../../connectors/activitypub/helpers',
  );
  return { ...actual, signedFetch: mocks.signedFetch };
});

vi.mock('../../utils/safeUpstreamFetch', async () => {
  const actual = await vi.importActual<typeof import('../../utils/safeUpstreamFetch')>(
    '../../utils/safeUpstreamFetch',
  );
  const { Readable } = await import('node:stream');
  return {
    ...actual,
    fetchUpstreamSingleHop: async () => ({
      response: Readable.from([Buffer.from(JSON.stringify(WEBFINGER_JRD))]),
      status: 200,
    }),
  };
});

vi.mock('../../models/FederatedActor', () => ({
  default: { findOne: mocks.actorFindOne, findOneAndUpdate: mocks.actorFindOneAndUpdate },
}));
vi.mock('../../models/FederatedFollow', () => ({
  default: { find: vi.fn(() => ({ lean: async () => [] })), findOne: vi.fn(() => ({ lean: async () => null })) },
}));
vi.mock('../../models/Post', () => ({ Post: { find: vi.fn() } }));
vi.mock('../../models/UserSettings', () => ({ default: { updateOne: vi.fn() } }));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(),
  getServiceOxyClient: () => ({
    makeServiceRequest: mocks.makeServiceRequest,
    getUserById: vi.fn(),
    getUsersByIds: vi.fn(async () => []),
  }),
}));

vi.mock('@oxyhq/core/server', () => ({ getRequiredOxyUserId: () => 'local-user-1' }));
vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
}));
vi.mock('../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: vi.fn(async () => true),
  invalidateFediverseSharing: vi.fn(),
}));
vi.mock('../../services/userSummaryCache', () => ({ invalidate: vi.fn() }));
vi.mock('../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: vi.fn(async () => ({ ok: false, permanent: true })),
}));

import connectorsRoutes from '../../connectors/connectors.routes';

const ACTOR_URI = 'https://bird.makeup/users/elonmusk';
const AVATAR = 'https://pbs.twimg.com/profile_images/2053244804520427520/m8mdWZCG.jpg';

const LIVE_ACTOR = {
  '@context': 'https://www.w3.org/ns/activitystreams',
  id: ACTOR_URI,
  type: 'Service',
  preferredUsername: 'elonmusk',
  name: 'Elon Musk',
  inbox: 'https://bird.makeup/users/elonmusk/inbox',
  outbox: 'https://bird.makeup/users/elonmusk/outbox',
  icon: { type: 'Image', url: AVATAR },
  summary:
    "<br>This account is a replica from Twitter. Its author can't see your replies. "
    + 'If you find this service useful, please consider supporting us via our Patreon. <br>',
  attachment: [
    {
      type: 'PropertyValue',
      name: 'Official',
      value:
        '<a href="https://twitter.com/elonmusk" rel="me nofollow noopener noreferrer" target="_blank">'
        + '<span class="invisible">https://</span><span class="ellipsis">twitter.com/elonmusk</span></a>',
    },
  ],
};

const app = express();
app.use(express.json());
app.use('/federation', connectorsRoutes);

/** The `$set` payload the ingest wrote for the actor row. */
let storedRow: Record<string, unknown>;

/** The body sent to `PUT /users/resolve`, or undefined when it was never called. */
function usersResolveBody(): Record<string, unknown> | undefined {
  const call = mocks.makeServiceRequest.mock.calls.find(([, path]) => path === '/users/resolve');
  return call?.[2] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  storedRow = {};
  mocks.actorFindOne.mockReturnValue({ lean: async () => null, select: () => ({ lean: async () => null }) });
  mocks.actorFindOneAndUpdate.mockImplementation((_filter: unknown, update: Record<string, unknown>) => {
    storedRow = (update.$set ?? {}) as Record<string, unknown>;
    return Promise.resolve({ ...storedRow, _id: 'row-1' });
  });
  mocks.makeServiceRequest.mockResolvedValue({ _id: 'oxy-elon' });
  mocks.signedFetch.mockImplementation(async (url: string) =>
    url === ACTOR_URI
      ? {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/activity+json' }),
          url,
          json: async () => LIVE_ACTOR,
          text: async () => JSON.stringify(LIVE_ACTOR),
        }
      : { ok: false, status: 404, headers: new Headers(), url, text: async () => '' });
});

describe('pasting https://x.com/elonmusk', () => {
  it('answers with the account, and asks Oxy to store the same one', async () => {
    const res = await request(app)
      .get('/federation/resolve')
      .query({ handle: 'https://x.com/elonmusk' });

    expect(res.status).toBe(200);
    // What the reader sees. `externalId` is the protocol id the follow is
    // addressed to, and stays pointed at the bridge.
    expect(res.body.actor).toMatchObject({
      network: 'activitypub',
      handle: 'elonmusk@x.com',
      externalId: ACTOR_URI,
      oxyUserId: 'oxy-elon',
      avatarUrl: AVATAR,
    });

    // The identity Oxy is asked to store, which is the thing the response must
    // agree with — the whole bug was these two disagreeing.
    expect(usersResolveBody()).toMatchObject({
      type: 'federated',
      username: 'elonmusk@x.com',
      domain: 'x.com',
      actorUri: ACTOR_URI,
      displayName: 'Elon Musk',
    });
    expect(res.body.actor.handle).toBe(usersResolveBody()?.username);
  });

  it('stores the bridge address on the row it keeps for reaching the actor', async () => {
    await request(app).get('/federation/resolve').query({ handle: 'https://x.com/elonmusk' });

    expect(storedRow).toMatchObject({
      acct: 'elonmusk@bird.makeup',
      domain: 'bird.makeup',
      networkAcct: 'elonmusk@x.com',
    });
  });

  it("does not keep the bridge's boilerplate notice as the account's bio", async () => {
    await request(app).get('/federation/resolve').query({ handle: 'https://x.com/elonmusk' });

    // This account's bio is the notice and nothing else, so nothing survives it.
    expect(storedRow.summary).toBe('');
  });

  it('never fetches the pasted URL', async () => {
    await request(app).get('/federation/resolve').query({ handle: 'https://x.com/elonmusk' });

    for (const [url] of mocks.signedFetch.mock.calls) {
      expect(String(url)).not.toContain('x.com');
    }
  });
});
