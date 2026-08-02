import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A fediverse PROFILE LINK in post content becomes a real mention.
 *
 * Two failures met in the reported post (a Sharkey 2025.4.7 note that mentioned
 * `@danirabbit@mastodon.online` and `@elementary@mastodon.social`):
 *
 *  1. Its `Mention` tags were CORRECT and its anchors matched them, but the
 *     mentioned actors did not resolve to an Oxy user at ingest time — so the
 *     anchors were left raw, and `htmlToPlainText` replaced each one with its
 *     HREF. The reader saw two bare `https://…/@user` URLs (with bogus link
 *     preview cards) instead of two handles. That degradation is fixed in
 *     `htmlToPlainText` (see its own suite) and re-pinned end-to-end here.
 *  2. Nothing ever tried to resolve the profile URL ITSELF. A profile link with no
 *     `Mention` tag behind it — someone pasted one, or the origin's tag failed —
 *     stayed a dead URL even when we already knew exactly who it named.
 *
 * The rule these pin: a profile link resolves LOOKUP-ONLY, against already-stored
 * `FederatedActor` rows and local Oxy users. A URL in post content is arbitrary
 * author-controlled text; dereferencing it would make every inbound post a request
 * to a host of the author's choosing. Unknown → left exactly as it is today.
 *
 * Mocking mirrors `apMentionsBridgy.test.ts` / `apMentionsSameInstance.test.ts`:
 * `actor.service` + `constants` + the `FederatedActor` model + `logger` are mocked,
 * so no network, DB or Oxy I/O runs; the rest of the graph is pure.
 */

const mocks = vi.hoisted(() => ({
  getOrFetchActor: vi.fn(),
  isBlockedDomain: vi.fn((_host: string) => false),
  resolveOxyUser: vi.fn(),
  findActorByUri: vi.fn(),
  findActorByAcct: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/actor.service', () => ({
  actorService: { getOrFetchActor: mocks.getOrFetchActor },
}));
vi.mock('../../../connectors/activitypub/constants', () => ({
  isBlockedDomain: mocks.isBlockedDomain,
  resolveOxyUser: mocks.resolveOxyUser,
}));
/**
 * The stored-actor lookup is TWO indexed point reads now — `uri` first, `acct`
 * only if that missed — rather than one `$or` over two unique keys. That shape
 * is what the counting assertion below keys on: one URI read per profile link,
 * which is the bound the ceiling exists to enforce.
 */
vi.mock('../../../db/federation/actorRepository', () => ({
  findActorByUri: mocks.findActorByUri,
  findActorByAcct: mocks.findActorByAcct,
}));
vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  applyMentionPlaceholders,
  resolveInboundMentions,
  resolveInboundMentionsExisting,
} from '../../../connectors/activitypub/apMentions';
import { htmlToPlainText } from '../../../utils/federation/htmlToPlainText';

const DANI_OXY_ID = 'oxy_danirabbit';
const ELEMENTARY_OXY_ID = 'oxy_elementary';

/**
 * The reported note, verbatim from the author's Sharkey outbox
 * (`https://alico.nexus/users/a2a8uu1ejveu0irq/outbox`): FLAT mention anchors
 * (no inner `<span>`), correct `Mention` tags whose `name` carries the domain.
 */
const SHARKEY_NOTE = {
  type: 'Note',
  content:
    '<p><a href="https://mastodon.online/@danirabbit" class="u-url mention">@danirabbit@mastodon.online</a> <a href="https://mastodon.social/@elementary" class="u-url mention">@elementary@mastodon.social</a> I used to sponsor elementary a few years ago</p>',
  tag: [
    {
      type: 'Mention',
      href: 'https://mastodon.online/users/danirabbit',
      name: '@danirabbit@mastodon.online',
    },
    {
      type: 'Mention',
      href: 'https://mastodon.social/users/elementary',
      name: '@elementary@mastodon.social',
    },
  ],
};

/**
 * Stub the stored-actor table. Keys are matched exactly as the code queries them:
 * by actor `uri` (the `/users/<id>` shape) and by `acct` (the `/@<user>` shape).
 */
function stubStoredActors(rows: { uri?: Record<string, string>; acct?: Record<string, string> }): void {
  mocks.findActorByUri.mockImplementation(async (uri: string) => {
    const oxyUserId = rows.uri?.[uri];
    return oxyUserId ? { oxyUserId } : null;
  });
  mocks.findActorByAcct.mockImplementation(async (acct: string) => {
    const oxyUserId = rows.acct?.[acct];
    return oxyUserId ? { oxyUserId } : null;
  });
}

beforeEach(() => {
  mocks.getOrFetchActor.mockReset();
  mocks.findActorByUri.mockReset();
  mocks.findActorByAcct.mockReset();
  mocks.resolveOxyUser.mockReset();
  mocks.isBlockedDomain.mockReset();
  mocks.isBlockedDomain.mockReturnValue(false);
  mocks.findActorByUri.mockResolvedValue(null);
  mocks.findActorByAcct.mockResolvedValue(null);
  mocks.getOrFetchActor.mockResolvedValue(null);
});

describe('the reported Sharkey note', () => {
  it('rewrites its FLAT mention anchors to placeholders when the tags resolve', async () => {
    mocks.getOrFetchActor.mockImplementation(async (href: string) =>
      href.includes('danirabbit') ? { oxyUserId: DANI_OXY_ID } : { oxyUserId: ELEMENTARY_OXY_ID },
    );

    const resolved = await resolveInboundMentions(SHARKEY_NOTE);
    expect(resolved.ids.sort()).toEqual([DANI_OXY_ID, ELEMENTARY_OXY_ID].sort());

    const rewritten = applyMentionPlaceholders(SHARKEY_NOTE, resolved.anchorMap);
    expect(rewritten.content).toBe(
      `<p>[mention:${DANI_OXY_ID}] [mention:${ELEMENTARY_OXY_ID}] I used to sponsor elementary a few years ago</p>`,
    );
  });

  it('degrades an UNRESOLVED mention to its handle, never to the raw profile URL', async () => {
    // Neither the tag (fetch returns nothing) nor the profile link (nothing stored)
    // resolves — the exact state the reported post was ingested in.
    const resolved = await resolveInboundMentions(SHARKEY_NOTE);
    expect(resolved.ids).toEqual([]);

    const rewritten = applyMentionPlaceholders(SHARKEY_NOTE, resolved.anchorMap);
    expect(rewritten.content).toBe(SHARKEY_NOTE.content);

    const stored = htmlToPlainText(String(rewritten.content));
    expect(stored).toBe(
      '@danirabbit@mastodon.online @elementary@mastodon.social I used to sponsor elementary a few years ago',
    );
    // The reported symptom: two raw profile URLs (which then grew link-preview cards).
    expect(stored).not.toContain('https://');
  });

  it('resolves its mentions from the PROFILE LINK when the tags do not resolve', async () => {
    // The stored rows are keyed by acct — which is all a `/@user` href can match.
    stubStoredActors({ acct: { 'danirabbit@mastodon.online': DANI_OXY_ID } });

    const resolved = await resolveInboundMentions(SHARKEY_NOTE);
    expect(resolved.ids).toEqual([DANI_OXY_ID]);

    const rewritten = applyMentionPlaceholders(SHARKEY_NOTE, resolved.anchorMap);
    expect(rewritten.content).toContain(`[mention:${DANI_OXY_ID}]`);
    // The unknown one is untouched, and still degrades to its handle.
    expect(htmlToPlainText(String(rewritten.content))).toContain('@elementary@mastodon.social');
  });
});

describe('a bare profile link with no Mention tag', () => {
  const PASTED_PROFILE = {
    type: 'Note',
    content:
      '<p>great work by <a href="https://mastodon.online/@danirabbit">mastodon.online/@danirabbit</a></p>',
  };

  it('becomes a real mention when the actor is already known', async () => {
    stubStoredActors({ acct: { 'danirabbit@mastodon.online': DANI_OXY_ID } });

    const resolved = await resolveInboundMentions(PASTED_PROFILE);
    // In the post's `mentions` allowlist, which is what lets hydration render the
    // placeholder as `@danirabbit@mastodon.online` with a working profile link.
    expect(resolved.ids).toEqual([DANI_OXY_ID]);
    expect(resolved.localIds).toEqual([]);

    const rewritten = applyMentionPlaceholders(PASTED_PROFILE, resolved.anchorMap);
    expect(rewritten.content).toBe(`<p>great work by [mention:${DANI_OXY_ID}]</p>`);
  });

  it('stays exactly as it is when the actor is NOT known', async () => {
    const resolved = await resolveInboundMentions(PASTED_PROFILE);
    expect(resolved.ids).toEqual([]);
    expect(applyMentionPlaceholders(PASTED_PROFILE, resolved.anchorMap).content).toBe(
      PASTED_PROFILE.content,
    );
    // …and the link still degrades to its href, as an ordinary link must.
    expect(htmlToPlainText(PASTED_PROFILE.content)).toBe(
      'great work by https://mastodon.online/@danirabbit',
    );
  });

  it('NEVER fetches the URL — not even on the live inbox path', async () => {
    await resolveInboundMentions(PASTED_PROFILE);
    // The live path fetches-and-creates for a `Mention` TAG; a URL sitting in
    // content is author-controlled text and must never be dereferenced.
    expect(mocks.getOrFetchActor).not.toHaveBeenCalled();
  });

  it('resolves the `/users/<id>` shape by actor URI', async () => {
    stubStoredActors({ uri: { 'https://misskey.example/users/9abc123': 'oxy_opaque' } });
    const object = {
      type: 'Note',
      content: '<p>see <a href="https://misskey.example/users/9abc123">this profile</a></p>',
    };

    const resolved = await resolveInboundMentions(object);
    expect(resolved.ids).toEqual(['oxy_opaque']);
    expect(applyMentionPlaceholders(object, resolved.anchorMap).content).toBe(
      '<p>see [mention:oxy_opaque]</p>',
    );
  });

  it('resolves a link to a LOCAL user through Oxy, as a notifiable mention', async () => {
    mocks.isBlockedDomain.mockImplementation((host: string) => host === 'mention.earth');
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'oxy_alice_local', username: 'alice' });
    const object = {
      type: 'Note',
      content: '<p>cc <a href="https://mention.earth/@alice">mention.earth/@alice</a></p>',
    };

    const resolved = await resolveInboundMentions(object);
    expect(resolved.ids).toEqual(['oxy_alice_local']);
    // A local user is the only one with a Mention inbox — and a link we render as a
    // mention notifies like one.
    expect(resolved.localIds).toEqual(['oxy_alice_local']);
    expect(mocks.resolveOxyUser).toHaveBeenCalledWith('alice');
  });

  it('leaves an ordinary link alone without spending a lookup on it', async () => {
    const object = {
      type: 'Note',
      content:
        '<p>read <a href="https://example.com/blog/a-post">example.com/blog/a-post</a> and <a href="https://medium.com/@author/some-slug">this</a></p>',
    };

    const resolved = await resolveInboundMentions(object);
    expect(resolved.ids).toEqual([]);
    // Neither href has a profile shape, so nothing is even looked up.
    expect(mocks.findActorByUri).not.toHaveBeenCalled();
    expect(applyMentionPlaceholders(object, resolved.anchorMap).content).toBe(object.content);
  });

  it('does not let ordinary links eat the cap ahead of a real profile link', async () => {
    stubStoredActors({ acct: { 'bob@m.example': 'oxy_bob' } });
    const noise = Array.from(
      { length: 10 },
      (_, i) => `<a href="https://example.com/post/${i}">a link</a>`,
    ).join(' ');
    const object = {
      type: 'Note',
      content: `<p>${noise} <a href="https://m.example/@bob">@bob</a></p>`,
    };

    // The cap counts CANDIDATES, not anchors: a link that cannot name a user is
    // filtered out by shape before it can occupy a slot.
    const resolved = await resolveInboundMentions(object);
    expect(resolved.ids).toEqual(['oxy_bob']);
  });

  it('caps how many profile links one note can turn into mentions', async () => {
    stubStoredActors({});
    const links = Array.from(
      { length: 12 },
      (_, i) => `<a href="https://m.example/@user${i}">@user${i}</a>`,
    ).join(' ');

    await resolveInboundMentions({ type: 'Note', content: `<p>${links}</p>` });

    // ONE uri read per resolved link, capped at the ceiling — the acct read is a
    // fallback for the links the first missed and is not the bound.
    expect(mocks.findActorByUri).toHaveBeenCalledTimes(8);
  });

  it('does not re-resolve a link a Mention tag already claimed', async () => {
    mocks.getOrFetchActor.mockResolvedValue({ oxyUserId: DANI_OXY_ID });
    stubStoredActors({});

    await resolveInboundMentions(SHARKEY_NOTE);

    // Both anchors are claimed by their (resolved) tags — no profile-link lookups.
    expect(mocks.findActorByUri).not.toHaveBeenCalled();
  });

  it('resolves on the lookup-only repair path too', async () => {
    stubStoredActors({ acct: { 'danirabbit@mastodon.online': DANI_OXY_ID } });

    const resolved = await resolveInboundMentionsExisting(PASTED_PROFILE);
    expect(resolved.ids).toEqual([DANI_OXY_ID]);
    expect(mocks.getOrFetchActor).not.toHaveBeenCalled();
  });
});
