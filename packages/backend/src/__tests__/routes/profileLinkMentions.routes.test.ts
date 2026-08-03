import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WOULD THIS URL BECOME A MENTION, AND OF WHOM — the composer's half of the
 * write-time fold.
 *
 * A profile link in a body becomes a real mention when the post is stored: the
 * id lands in `post.mentions`, which notifies the person named. The composer can
 * answer that for a profile on this instance by itself; it cannot for a link to
 * another fediverse host, whose answer lives in `FederatedActor` rows. This
 * route is those rows' lookup-only front door, and these pin the properties that
 * make it safe to point a composer at:
 *
 *  - it never fetches the pasted URL and never creates an actor — unlike
 *    `GET /federation/resolve`, which would make the composer CAUSE the mention
 *    it is describing;
 *  - it decides from the URL, through the same resolver the fold calls, so the
 *    screen and the write path cannot disagree about which account a URL names;
 *  - a URL we hold nobody for answers `null`, so a link that will stay a link is
 *    described as one;
 *  - hostile input is refused at the boundary, and no request can ask for more
 *    lookups than a post could ever cause.
 *
 * Mocked at the SAME seams the fold's own suite uses — the federation
 * `constants` and the `FederatedActor` model — so the URLs below travel through
 * the real `resolveProfileLinkIdentity`, the real percent-decoding and the real
 * own-host gate rather than through a stub of them.
 */

const mocks = vi.hoisted(() => ({
  isBlockedDomain: vi.fn((_host: string) => false),
  resolveOxyUser: vi.fn(),
  findExistingActor: vi.fn(),
  resolveUserSummaries: vi.fn(),
}));

// Spread over the real module rather than replacing it: this route reaches the
// real `PostHydrationService`, whose module graph reads the rest of these
// constants at load. Only the two seams the resolver consults are stubbed.
vi.mock('../../connectors/activitypub/constants', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isBlockedDomain: mocks.isBlockedDomain,
  resolveOxyUser: mocks.resolveOxyUser,
}));
vi.mock('../../models/FederatedActor', () => ({
  default: { findOne: mocks.findExistingActor },
}));
// Only the Oxy round trip is stubbed. `isFallbackUserSummary` stays REAL: it is
// the predicate that decides whether an id is nameable, and a copy of it here
// would be a second opinion about the case this route reports as no mention.
vi.mock('../../services/PostHydrationService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveUserSummaries: mocks.resolveUserSummaries,
}));

import { MAX_PROFILE_LINKS_PER_BODY } from '@mention/shared-types';
import profileLinkMentionsRoutes from '../../routes/profileLinkMentions.routes';

/** This instance's own web host, as the federation domain policy sees it. */
const OWN_HOST = 'mention.earth';
const ALICE_OXY_ID = 'oxy_alice_local';
const BOB_OXY_ID = 'oxy_bob_federated';

const app = express();
app.use(express.json());
app.use('/mentions', profileLinkMentionsRoutes);

/** A resolved Oxy summary in the shape `resolveUserSummaries` returns. */
function summary(id: string, user: Record<string, unknown>) {
  return [id, { user: { id, ...user } }] as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isBlockedDomain.mockImplementation(
    (host: string) => host.toLowerCase().replace(/^www\./, '') === OWN_HOST,
  );
  mocks.resolveOxyUser.mockResolvedValue(null);
  mocks.findExistingActor.mockReturnValue({ lean: async () => null });
  mocks.resolveUserSummaries.mockResolvedValue(new Map());
});

describe('POST /mentions/profile-links', () => {
  it('names the federated account a link to ANOTHER host will mention', async () => {
    // The gap this route exists to close: the composer cannot see this answer,
    // and the write boundary folds the link anyway.
    mocks.findExistingActor.mockReturnValue({
      lean: async () => ({ oxyUserId: BOB_OXY_ID }),
    });
    mocks.resolveUserSummaries.mockResolvedValue(
      new Map([
        summary(BOB_OXY_ID, {
          username: 'bob',
          isFederated: true,
          instance: 'mastodon.social',
          name: { displayName: 'Bob' },
        }),
      ]),
    );

    const response = await request(app)
      .post('/mentions/profile-links')
      .send({ urls: ['https://mastodon.social/@bob'] });

    expect(response.status).toBe(200);
    expect(response.body.links).toEqual([
      {
        url: 'https://mastodon.social/@bob',
        // The CANONICAL handle, exactly as `PostHydrationService` renders the
        // stored placeholder — not the bare username the row happens to store.
        mention: { userId: BOB_OXY_ID, handle: 'bob@mastodon.social', displayName: 'Bob' },
      },
    ]);
  });

  it('never fetches the pasted URL and never creates an actor', async () => {
    // The property that rules `GET /federation/resolve` out as a substitute: it
    // resolves by FETCHING and STORING, which would make looking at a link the
    // thing that makes it mentionable.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await request(app)
      .post('/mentions/profile-links')
      .send({ urls: ['https://mastodon.social/@nobody-we-store'] });

    expect(fetchSpy).not.toHaveBeenCalled();
    // The stored-actor model is exposed to this route as a READ and nothing
    // else; a create/update seam appearing here would be the regression.
    expect(mocks.findExistingActor).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('says a link we hold nobody for stays a link', async () => {
    const response = await request(app)
      .post('/mentions/profile-links')
      .send({ urls: ['https://mastodon.social/@stranger'] });

    expect(response.status).toBe(200);
    expect(response.body.links).toEqual([
      { url: 'https://mastodon.social/@stranger', mention: null },
    ]);
  });

  it('decides from the URL, so a percent-encoded own-host handle resolves', async () => {
    // The divergence a URL-in endpoint removes: the composer reads a DECODED
    // handle off the URL, and the write path used to resolve the raw segment.
    // Both now travel through the same `ownProfileUrlHandle`.
    mocks.resolveOxyUser.mockImplementation(async (username: string) =>
      username === 'café' ? { _id: ALICE_OXY_ID } : null,
    );
    mocks.resolveUserSummaries.mockResolvedValue(
      new Map([summary(ALICE_OXY_ID, { username: 'café', name: { displayName: 'Café' } })]),
    );

    const response = await request(app)
      .post('/mentions/profile-links')
      .send({ urls: [`https://${OWN_HOST}/@caf%C3%A9`] });

    expect(mocks.resolveOxyUser).toHaveBeenCalledWith('café');
    expect(response.body.links[0].mention).toEqual({
      userId: ALICE_OXY_ID,
      handle: 'café',
      displayName: 'Café',
    });
  });

  it('never asks Oxy to resolve a MODERATION-blocked host’s handle as one of ours', async () => {
    mocks.isBlockedDomain.mockImplementation(
      (host: string) => ['poa.st', OWN_HOST].includes(host.toLowerCase().replace(/^www\./, '')),
    );

    const response = await request(app)
      .post('/mentions/profile-links')
      .send({ urls: ['https://poa.st/@alice'] });

    expect(mocks.resolveOxyUser).not.toHaveBeenCalled();
    expect(response.body.links).toEqual([{ url: 'https://poa.st/@alice', mention: null }]);
  });

  it('falls back to the handle when the account declares no display name', async () => {
    mocks.resolveOxyUser.mockImplementation(async (username: string) =>
      username === 'alice' ? { _id: ALICE_OXY_ID } : null,
    );
    mocks.resolveUserSummaries.mockResolvedValue(
      new Map([summary(ALICE_OXY_ID, { username: 'alice', name: {} })]),
    );

    const response = await request(app)
      .post('/mentions/profile-links')
      .send({ urls: [`https://${OWN_HOST}/@alice`] });

    expect(response.body.links[0].mention).toEqual({
      userId: ALICE_OXY_ID,
      handle: 'alice',
      displayName: 'alice',
    });
  });

  it('reports an id it could not NAME as no mention, rather than as a nameless one', async () => {
    // A degraded summary is what an Oxy lookup that failed leaves behind. The
    // fold is fail-soft per link, so under-stating keeps the two in agreement —
    // and a row reading "@" would be worse than no row.
    mocks.resolveOxyUser.mockImplementation(async (username: string) =>
      username === 'alice' ? { _id: ALICE_OXY_ID } : null,
    );
    mocks.resolveUserSummaries.mockResolvedValue(
      new Map([summary(ALICE_OXY_ID, { username: '', name: {} })]),
    );

    const response = await request(app)
      .post('/mentions/profile-links')
      .send({ urls: [`https://${OWN_HOST}/@alice`] });

    expect(response.body.links).toEqual([{ url: `https://${OWN_HOST}/@alice`, mention: null }]);
  });

  it('answers every requested URL, in request order, including duplicates', async () => {
    // Two spellings of one profile are one lookup and two answers: the caller
    // matches answers to the URLs in ITS body, and the server authorizes the id
    // once either way.
    mocks.resolveOxyUser.mockImplementation(async (username: string) =>
      username === 'alice' ? { _id: ALICE_OXY_ID } : null,
    );
    mocks.resolveUserSummaries.mockResolvedValue(
      new Map([summary(ALICE_OXY_ID, { username: 'alice', name: { displayName: 'Alice' } })]),
    );

    const response = await request(app)
      .post('/mentions/profile-links')
      .send({
        urls: [
          `https://${OWN_HOST}/@alice`,
          'https://example.com/not-a-profile',
          `https://${OWN_HOST}/@alice`,
        ],
      });

    expect(response.body.links.map((link: { url: string }) => link.url)).toEqual([
      `https://${OWN_HOST}/@alice`,
      'https://example.com/not-a-profile',
      `https://${OWN_HOST}/@alice`,
    ]);
    expect(response.body.links[0].mention.userId).toBe(ALICE_OXY_ID);
    expect(response.body.links[1].mention).toBeNull();
    expect(response.body.links[2].mention.userId).toBe(ALICE_OXY_ID);
    // Resolved ONCE despite being asked twice.
    expect(mocks.resolveOxyUser).toHaveBeenCalledTimes(1);
  });

  it('refuses a URL that is not http(s) before anything looks it up', async () => {
    const response = await request(app)
      .post('/mentions/profile-links')
      .send({ urls: ['javascript:alert(1)'] });

    expect(response.status).toBe(400);
    expect(mocks.resolveOxyUser).not.toHaveBeenCalled();
    expect(mocks.findExistingActor).not.toHaveBeenCalled();
  });

  it('refuses a value that is not a URL at all', async () => {
    const response = await request(app)
      .post('/mentions/profile-links')
      .send({ urls: ['alice'] });

    expect(response.status).toBe(400);
    expect(mocks.findExistingActor).not.toHaveBeenCalled();
  });

  it(`refuses more than ${MAX_PROFILE_LINKS_PER_BODY} URLs — the ceiling a post could cause`, async () => {
    const urls = Array.from(
      { length: MAX_PROFILE_LINKS_PER_BODY + 1 },
      (_, index) => `https://mastodon.social/@user${index}`,
    );

    const response = await request(app).post('/mentions/profile-links').send({ urls });

    expect(response.status).toBe(400);
    expect(mocks.findExistingActor).not.toHaveBeenCalled();
  });

  it(`answers exactly ${MAX_PROFILE_LINKS_PER_BODY} URLs`, async () => {
    const urls = Array.from(
      { length: MAX_PROFILE_LINKS_PER_BODY },
      (_, index) => `https://mastodon.social/@user${index}`,
    );

    const response = await request(app).post('/mentions/profile-links').send({ urls });

    expect(response.status).toBe(200);
    expect(response.body.links).toHaveLength(MAX_PROFILE_LINKS_PER_BODY);
  });

  it('leaves the rest of the body answered when one lookup throws', async () => {
    // Fail-soft per URL, exactly as the fold is.
    mocks.resolveOxyUser.mockImplementation(async (username: string) => {
      if (username === 'boom') throw new Error('oxy unavailable');
      return username === 'alice' ? { _id: ALICE_OXY_ID } : null;
    });
    mocks.resolveUserSummaries.mockResolvedValue(
      new Map([summary(ALICE_OXY_ID, { username: 'alice', name: { displayName: 'Alice' } })]),
    );

    const response = await request(app)
      .post('/mentions/profile-links')
      .send({ urls: [`https://${OWN_HOST}/@boom`, `https://${OWN_HOST}/@alice`] });

    expect(response.status).toBe(200);
    expect(response.body.links[0].mention).toBeNull();
    expect(response.body.links[1].mention.userId).toBe(ALICE_OXY_ID);
  });

  it('spends no lookup on an ordinary link', async () => {
    const response = await request(app)
      .post('/mentions/profile-links')
      .send({ urls: ['https://example.com/blog/post-1'] });

    expect(response.status).toBe(200);
    expect(response.body.links).toEqual([
      { url: 'https://example.com/blog/post-1', mention: null },
    ]);
    // Not profile-shaped, so it never reaches the stored-actor table — and the
    // name resolver is asked about nobody.
    expect(mocks.findExistingActor).not.toHaveBeenCalled();
    expect(mocks.resolveUserSummaries).toHaveBeenCalledWith([]);
  });
});
