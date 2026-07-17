import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Inbound Bridgy Fed (brid.gy) @mention resolution.
 *
 * A bridged Bluesky mention's `Mention` tag carries the brid.gy actor URI
 * (`https://bsky.brid.gy/ap/<did>`) as `href` and `@<handle>@bsky.brid.gy` as
 * `name`, but the anchor INSIDE the content points at the Bluesky WEB profile —
 * `https://bsky.app/profile/<did|handle>` — which matched neither the actor URI
 * nor the reconstructed profile URL, so the mention fell through to bare text.
 * These pin that both bsky.app anchor forms now resolve to the internal
 * `[mention:<oxyUserId>]` placeholder, and that the Mastodon path still resolves.
 *
 * `actor.service` and `constants` are mocked so no network / DB / Oxy I/O runs;
 * the rest of the module graph (`bridgy`, `apLanguage`, `apSchemas`) is pure.
 */

const mocks = vi.hoisted(() => ({
  getOrFetchActor: vi.fn(),
  isBlockedDomain: vi.fn(() => false),
  resolveOxyUser: vi.fn(),
  findExistingActor: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/actor.service', () => ({
  actorService: { getOrFetchActor: mocks.getOrFetchActor },
}));
vi.mock('../../../connectors/activitypub/constants', () => ({
  isBlockedDomain: mocks.isBlockedDomain,
  resolveOxyUser: mocks.resolveOxyUser,
}));
vi.mock('../../../models/FederatedActor', () => ({
  default: { findOne: mocks.findExistingActor },
}));
vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  applyMentionPlaceholders,
  resolveInboundMentions,
  resolveInboundMentionsExisting,
} from '../../../connectors/activitypub/apMentions';

const DID = 'did:plc:reu7q3altx5gsonhu5nxcfp6';
const HANDLE = 'alice.bsky.social';
const BRIDGY_ACTOR = `https://bsky.brid.gy/ap/${DID}`;
const BRIDGED_OXY_ID = 'oxy_bridged_alice';

beforeEach(() => {
  mocks.getOrFetchActor.mockReset();
  mocks.findExistingActor.mockReset();
  mocks.isBlockedDomain.mockReturnValue(false);
});

describe('inbound brid.gy @mention resolution', () => {
  it('rewrites a bsky.app/profile/<handle> mention anchor to the placeholder', async () => {
    mocks.getOrFetchActor.mockResolvedValue({ oxyUserId: BRIDGED_OXY_ID });
    const object = {
      content: `<p>hi <a href="https://bsky.app/profile/${HANDLE}">@${HANDLE}</a></p>`,
      tag: [{ type: 'Mention', href: BRIDGY_ACTOR, name: `@${HANDLE}@bsky.brid.gy` }],
    };

    const resolved = await resolveInboundMentions(object);
    expect(resolved.ids).toContain(BRIDGED_OXY_ID);

    const rewritten = applyMentionPlaceholders(object, resolved.anchorMap);
    expect(rewritten.content).toBe(`<p>hi [mention:${BRIDGED_OXY_ID}]</p>`);
  });

  it('rewrites a bsky.app/profile/<did> mention anchor to the placeholder', async () => {
    mocks.getOrFetchActor.mockResolvedValue({ oxyUserId: BRIDGED_OXY_ID });
    const object = {
      content: `<p><a href="https://bsky.app/profile/${DID}">@${HANDLE}</a> hello</p>`,
      tag: [{ type: 'Mention', href: BRIDGY_ACTOR, name: `@${HANDLE}@bsky.brid.gy` }],
    };

    const resolved = await resolveInboundMentions(object);
    const rewritten = applyMentionPlaceholders(object, resolved.anchorMap);
    expect(rewritten.content).toBe(`<p>[mention:${BRIDGED_OXY_ID}] hello</p>`);
  });

  it('still resolves a Mastodon mention (regression): actor-URI tag href, profile-page anchor', async () => {
    mocks.getOrFetchActor.mockResolvedValue({ oxyUserId: 'oxy_bob' });
    const object = {
      content: '<p><a href="https://mastodon.social/@bob" class="u-url mention">@bob</a></p>',
      tag: [{ type: 'Mention', href: 'https://mastodon.social/users/bob', name: '@bob@mastodon.social' }],
    };

    const resolved = await resolveInboundMentions(object);
    const rewritten = applyMentionPlaceholders(object, resolved.anchorMap);
    expect(rewritten.content).toBe('<p>[mention:oxy_bob]</p>');
  });
});

/**
 * Lookup-only mention resolution — the ghost-safe path the one-shot repair uses.
 * A repair must NEVER fetch or create a `FederatedActor`: it resolves each mention
 * against already-stored actors only, and leaves an unknown mention as raw text
 * rather than minting a 0-post ghost user.
 */
describe('lookup-only inbound @mention resolution (repair path)', () => {
  it('resolves an already-stored federated actor without fetching/creating one', async () => {
    mocks.findExistingActor.mockReturnValue({
      lean: () => Promise.resolve({ oxyUserId: 'oxy_bob' }),
    });
    const object = {
      content: '<p><a href="https://mastodon.social/@bob" class="u-url mention">@bob</a></p>',
      tag: [{ type: 'Mention', href: 'https://mastodon.social/users/bob', name: '@bob@mastodon.social' }],
    };

    const resolved = await resolveInboundMentionsExisting(object);
    expect(resolved.ids).toContain('oxy_bob');
    expect(mocks.getOrFetchActor).not.toHaveBeenCalled();
    expect(mocks.findExistingActor).toHaveBeenCalledWith(
      { uri: 'https://mastodon.social/users/bob' },
      { oxyUserId: 1 },
    );

    const rewritten = applyMentionPlaceholders(object, resolved.anchorMap);
    expect(rewritten.content).toBe('<p>[mention:oxy_bob]</p>');
  });

  it('skips an unknown actor: leaves the raw anchor and never fetches/creates one', async () => {
    mocks.findExistingActor.mockReturnValue({ lean: () => Promise.resolve(null) });
    const content = `<p>hi <a href="https://bsky.app/profile/${HANDLE}">@${HANDLE}</a></p>`;
    const object = {
      content,
      tag: [{ type: 'Mention', href: BRIDGY_ACTOR, name: `@${HANDLE}@bsky.brid.gy` }],
    };

    const resolved = await resolveInboundMentionsExisting(object);
    expect(resolved.ids).toEqual([]);
    expect(resolved.anchorMap.size).toBe(0);
    expect(mocks.getOrFetchActor).not.toHaveBeenCalled();

    const rewritten = applyMentionPlaceholders(object, resolved.anchorMap);
    expect(rewritten.content).toBe(content);
  });
});
