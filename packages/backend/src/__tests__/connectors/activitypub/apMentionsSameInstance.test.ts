import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  seedActor,
} from '../../helpers/federationFixtures';

const scope = federationScope('ap-mentions-same-instance');

/**
 * Inbound @mention resolution when the mention is SAME-INSTANCE.
 *
 * Mastodon writes the `Mention` tag `name` relative to the AUTHOR: a mention of
 * someone on the author's own instance gets the BARE `@user`, with no `@domain`
 * suffix. Only a cross-instance mention carries `@user@domain`.
 *
 * The in-content anchor still points at the human profile URL
 * (`https://host/@user`) while the tag `href` is the actor URI
 * (`https://host/users/user`) — the two differ, which is exactly why the anchor
 * is matched against a RECONSTRUCTED profile URL. That reconstruction read the
 * domain out of the tag `name`, so the bare form produced no candidate at all:
 * the anchor matched nothing, was left untouched, and `htmlToPlainText` stripped
 * it to dead `@user` text — no domain, no display name, no link. Since most
 * conversations happen between users of the same instance, this was the common
 * case rather than an edge one.
 *
 * The payload below is captured verbatim from the real toot that surfaced this
 * (`https://mastodon.social/@Gargron/117016521955489722`, fetched as
 * `application/activity+json`).
 *
 * Mocking mirrors the sibling `apMentionsBridgy.test.ts`: `actor.service` and
 * `constants` are mocked so no network / DB / Oxy I/O runs; the rest of the
 * module graph is pure.
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

import {
  applyMentionPlaceholders,
  resolveInboundMentions,
  resolveInboundMentionsExisting,
} from '../../../connectors/activitypub/apMentions';

const MENTIONED_OXY_ID = 'oxy_indigoparadox';

/** The real Note, verbatim from mastodon.social. */
const SAME_INSTANCE_NOTE = {
  type: 'Note',
  content:
    '<p><span class="h-card" translate="no"><a href="https://mastodon.social/@indigoparadox" class="u-url mention">@<span>indigoparadox</span></a></span> No, none of that.</p>',
  // `name` is the BARE handle — no `@mastodon.social` suffix — because author and
  // mentioned user share an instance.
  tag: [
    {
      type: 'Mention',
      href: 'https://mastodon.social/users/indigoparadox',
      name: '@indigoparadox',
    },
  ],
};

/** The cross-instance shape, which already worked — kept so the fix cannot regress it. */
const CROSS_INSTANCE_NOTE = {
  type: 'Note',
  content:
    '<p><a href="https://remote.example/@bob" class="u-url mention">@<span>bob</span></a> hello</p>',
  tag: [
    { type: 'Mention', href: 'https://remote.example/users/bob', name: '@bob@remote.example' },
  ],
};

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  await clearFederationScope(scope);
  mocks.getOrFetchActor.mockReset();
  mocks.isBlockedDomain.mockReturnValue(false);
});

describe('same-instance mention (bare `@user` tag name)', () => {
  it('rewrites the profile-URL anchor to a placeholder on the live inbox path', async () => {
    mocks.getOrFetchActor.mockResolvedValue({ oxyUserId: MENTIONED_OXY_ID });

    const resolved = await resolveInboundMentions(SAME_INSTANCE_NOTE);
    expect(resolved.ids).toEqual([MENTIONED_OXY_ID]);

    const rewritten = applyMentionPlaceholders(SAME_INSTANCE_NOTE, resolved.anchorMap);
    // The anchor becomes the internal placeholder, so hydration renders the full
    // `@user@domain` handle as a real profile link — as for a native mention.
    expect(rewritten.content).toContain(`[mention:${MENTIONED_OXY_ID}]`);
    // …and the dead anchor is gone.
    expect(rewritten.content).not.toContain('https://mastodon.social/@indigoparadox');
    expect(rewritten.content).toContain('No, none of that.');
  });

  it('maps the profile URL derived from the tag href host', async () => {
    mocks.getOrFetchActor.mockResolvedValue({ oxyUserId: MENTIONED_OXY_ID });

    const { anchorMap } = await resolveInboundMentions(SAME_INSTANCE_NOTE);

    // The actor URI stays a candidate (Pleroma, our own round-tripped posts)…
    expect(anchorMap.get('https://mastodon.social/users/indigoparadox')).toBe(MENTIONED_OXY_ID);
    // …and the profile URL is now derived from the HREF's host, not from a domain
    // suffix the bare `name` never had.
    expect(anchorMap.get('https://mastodon.social/@indigoparadox')).toBe(MENTIONED_OXY_ID);
  });

  it('resolves on the lookup-only repair path too', async () => {
    await seedActor(scope, {
      username: 'indigoparadox',
      uri: 'https://mastodon.social/users/indigoparadox',
      oxyUserId: MENTIONED_OXY_ID,
    });

    const resolved = await resolveInboundMentionsExisting(SAME_INSTANCE_NOTE);
    const rewritten = applyMentionPlaceholders(SAME_INSTANCE_NOTE, resolved.anchorMap);
    expect(rewritten.content).toContain(`[mention:${MENTIONED_OXY_ID}]`);
    // The repair path must never fetch or create an actor.
    expect(mocks.getOrFetchActor).not.toHaveBeenCalled();
  });

  it('still resolves the cross-instance `@user@domain` form', async () => {
    mocks.getOrFetchActor.mockResolvedValue({ oxyUserId: 'oxy_bob' });

    const resolved = await resolveInboundMentions(CROSS_INSTANCE_NOTE);
    const rewritten = applyMentionPlaceholders(CROSS_INSTANCE_NOTE, resolved.anchorMap);
    expect(rewritten.content).toContain('[mention:oxy_bob]');
  });

  it('leaves an unresolvable mention as bare text rather than mis-linking', async () => {
    mocks.getOrFetchActor.mockResolvedValue(null);

    const resolved = await resolveInboundMentions(SAME_INSTANCE_NOTE);
    expect(resolved.ids).toEqual([]);
    expect(applyMentionPlaceholders(SAME_INSTANCE_NOTE, resolved.anchorMap).content).toBe(
      SAME_INSTANCE_NOTE.content,
    );
  });

  it('does not invent a candidate when the tag carries no usable name', async () => {
    mocks.getOrFetchActor.mockResolvedValue({ oxyUserId: MENTIONED_OXY_ID });

    const { anchorMap } = await resolveInboundMentions({
      type: 'Note',
      content: '<p>hi</p>',
      tag: [{ type: 'Mention', href: 'https://mastodon.social/users/indigoparadox' }],
    });

    // Only the actor URI — a username guessed from the href path would be wrong on
    // servers whose actor URI carries an opaque id (Misskey).
    expect([...anchorMap.keys()]).toEqual(['https://mastodon.social/users/indigoparadox']);
  });
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});
