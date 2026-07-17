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
}));

vi.mock('../../../connectors/activitypub/actor.service', () => ({
  actorService: { getOrFetchActor: mocks.getOrFetchActor },
}));
vi.mock('../../../connectors/activitypub/constants', () => ({
  isBlockedDomain: mocks.isBlockedDomain,
  resolveOxyUser: mocks.resolveOxyUser,
}));
vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { applyMentionPlaceholders, resolveInboundMentions } from '../../../connectors/activitypub/apMentions';

const DID = 'did:plc:reu7q3altx5gsonhu5nxcfp6';
const HANDLE = 'alice.bsky.social';
const BRIDGY_ACTOR = `https://bsky.brid.gy/ap/${DID}`;
const BRIDGED_OXY_ID = 'oxy_bridged_alice';

beforeEach(() => {
  mocks.getOrFetchActor.mockReset();
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
