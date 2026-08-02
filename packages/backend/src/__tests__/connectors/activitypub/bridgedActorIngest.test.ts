import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * INGESTING A BRIDGED ACTOR, DRIVEN BY THE ACTOR DOCUMENT THE BRIDGE ACTUALLY
 * SERVES.
 *
 * Everything else about the re-labelling is tested against
 * `NetworkIdentityCandidate` fixtures — the shape a derivation rule is handed
 * AFTER the pipeline has already sanitized the profile fields and flattened the
 * bio to plain text. That is the right input for testing a RULE, and it is the
 * wrong input for testing the PIPELINE, because it assumes the very steps that
 * decide whether the rule ever sees something it can match.
 *
 * The boilerplate patterns are the sharp case. Anchored at the end of the bio,
 * they match the bridge's notice once `<br>` has become a newline and the entities
 * are decoded — and do not match the raw HTML at all. So "the pattern is correct"
 * and "the notice is removed from what we store" are two different claims, and
 * only the second one is what a reader sees. This test asserts the second, from
 * the bytes, so that a change to the ORDER of the ingest steps (or to
 * `htmlToPlainText`) fails here rather than quietly reinstating the notice on
 * every mirrored profile.
 *
 * Captured live from `https://bird.makeup/users/elonmusk` on 2026-08-03, with
 * `Accept: application/activity+json`. Only the fields the ingest reads are kept.
 */

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  resolveFederatedActorIdentity: vi.fn(),
  signedFetch: vi.fn(),
}));

vi.mock('../../../models/FederatedActor', () => ({
  default: { findOne: mocks.findOne, findOneAndUpdate: mocks.findOneAndUpdate },
}));

vi.mock('../../../connectors/identity', () => ({
  reportFederatedActorGone: vi.fn(),
  resolveFederatedActorIdentity: mocks.resolveFederatedActorIdentity,
}));

// Only the network call is stubbed. The bridge policy, the boilerplate patterns,
// the field sanitizer and `htmlToPlainText` are all the real ones — they are what
// is under test.
vi.mock('../../../connectors/activitypub/helpers', async () => {
  const actual = await vi.importActual<typeof import('../../../connectors/activitypub/helpers')>(
    '../../../connectors/activitypub/helpers',
  );
  return { ...actual, signedFetch: mocks.signedFetch };
});

import { actorService } from '../../../connectors/activitypub/actor.service';

const ACTOR_URI = 'https://bird.makeup/users/elonmusk';

/** The live actor document, verbatim. */
const LIVE_ACTOR = {
  '@context': 'https://www.w3.org/ns/activitystreams',
  id: ACTOR_URI,
  type: 'Service',
  preferredUsername: 'elonmusk',
  name: 'Elon Musk',
  inbox: 'https://bird.makeup/users/elonmusk/inbox',
  outbox: 'https://bird.makeup/users/elonmusk/outbox',
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
    {
      type: 'PropertyValue',
      name: 'Support this service',
      value:
        '<a href="https://www.patreon.com/birddotmakeup" rel="me nofollow noopener noreferrer" target="_blank">'
        + '<span class="invisible">https://</span><span class="ellipsis">www.patreon.com/birddotmakeup</span></a>',
    },
  ],
};

/** The `$set` payload the ingest wrote for the actor row. */
let storedRow: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  storedRow = {};
  mocks.resolveFederatedActorIdentity.mockResolvedValue('oxy-user-1');
  mocks.findOneAndUpdate.mockImplementation((_filter: unknown, update: Record<string, unknown>) => {
    storedRow = (update.$set ?? {}) as Record<string, unknown>;
    return Promise.resolve({ ...storedRow, _id: 'row-1' });
  });
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

describe('ingesting a live bird.makeup actor', () => {
  it('stores the identity on the network the account really belongs to', async () => {
    await actorService.fetchRemoteActor(ACTOR_URI);

    // The identity moved; the PROTOCOL address did not. Both matter: the domain
    // policy and every moderation consumer read `acct`/`uri`/`domain`.
    expect(storedRow).toMatchObject({
      networkAcct: 'elonmusk@x.com',
      acct: 'elonmusk@bird.makeup',
      domain: 'bird.makeup',
      uri: ACTOR_URI,
    });
  });

  it("strips the bridge's own notice out of the bio it stores", async () => {
    await actorService.fetchRemoteActor(ACTOR_URI);

    // This account's bio is the notice and nothing else, so the whole thing goes.
    expect(storedRow.summary).toBe('');
  });

  it('hands the re-labelled identity to the Oxy identity bridge', async () => {
    await actorService.fetchRemoteActor(ACTOR_URI);

    expect(mocks.resolveFederatedActorIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.resolveFederatedActorIdentity.mock.calls[0][0]).toMatchObject({
      externalId: ACTOR_URI,
      handle: 'elonmusk@bird.makeup',
      federatedUsername: 'elonmusk@x.com',
      instanceDomain: 'x.com',
      displayName: 'Elon Musk',
    });
  });

  it('leaves the bridge operator\'s own account alone', async () => {
    // No `Official` rel="me" link to X ⇒ the rule does not fire, so the actor
    // keeps the bridge identity. That is what stops the operator from being
    // published as somebody on a network they may not use.
    const admin = {
      ...LIVE_ACTOR,
      id: 'https://bird.makeup/users/admin',
      preferredUsername: 'admin',
      summary: '<p>I run this bridge.</p>',
      attachment: [],
    };
    mocks.signedFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/activity+json' }),
      url,
      json: async () => admin,
      text: async () => JSON.stringify(admin),
    }));

    await actorService.fetchRemoteActor('https://bird.makeup/users/admin');

    expect(storedRow.networkAcct).toBeUndefined();
    expect(storedRow.summary).toBe('I run this bridge.');
    expect(mocks.resolveFederatedActorIdentity.mock.calls[0][0]).toMatchObject({
      federatedUsername: 'admin@bird.makeup',
      instanceDomain: 'bird.makeup',
    });
  });
});
