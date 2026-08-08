import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Outbound QUOTE-POST federation: a Mention quote post is a normal Note (its own
 * commentary in `content`) PLUS a reference to the quoted post. These pin two
 * things:
 *
 *  1. the PURE builder (`buildCreateNoteActivity` with a resolved quote context):
 *     it emits the quoted object's canonical AP id under the modern
 *     `quote`/`quoteUri` (FEP-044f / Mastodon 4.4+) AND legacy
 *     `_misskey_quote`/`quoteUrl` (Misskey/Pleroma) fields, PLUS the FEP-e232
 *     `Link` quote tag — and does NOT append the quoted URL into `content` (that
 *     would double-render on quote-aware servers). A non-quote post emits none of
 *     these, and a boost never carries a quote context.
 *  2. the DB-read resolver (`resolveQuoteContext` / `resolveQuoteContextByPost`):
 *     it reuses `resolveFederationTarget` to turn the local `quoteOf` id into the
 *     quoted object's canonical AP uri — a FEDERATED quoted post → its remote
 *     `federation.activityId`; a LOCAL quoted post → its minted
 *     `/ap/users/<owner>/posts/<id>` uri; deduped across a batch.
 *
 * The builder's transitive deps are stubbed so `FollowService` imports in
 * isolation. The QUOTED POST and any federated actor are REAL ROWS: the whole
 * resolver is `resolveFederationTarget` reading a post and deciding, from
 * whether that row carries a `federation.activityId`, which of the two URI
 * shapes to emit. Under the previous `Post.findById` stub the answer was the
 * mock's, so a resolver that found nothing and one that found the wrong row were
 * indistinguishable — and a quote that silently resolves to null federates as
 * bare commentary with the quoted post dropped.
 *
 * The Oxy client stays mocked: it owns usernames, and it is a remote service.
 */

vi.mock('../../../connectors/activitypub/actor.service', () => ({ actorService: {} }));
vi.mock('../../../connectors/activitypub/crypto', () => ({ getPublicKey: vi.fn(), signRequest: vi.fn() }));
vi.mock('../../../queue/producers', () => ({ enqueueDelivery: vi.fn(), enqueueInboxActivity: vi.fn() }));
vi.mock('../../../utils/safeUpstreamFetch', () => ({ fetchUpstreamSingleHop: vi.fn() }));
vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  assertSafePublicUrl: vi.fn(),
}));
vi.mock('../../../utils/mediaResolver', () => ({
  resolveMediaRef: (ref: string) => ({ url: `https://cloud.oxy.so/${ref}` }),
}));

const { getUserById } = vi.hoisted(() => ({ getUserById: vi.fn() }));

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUserById }),
}));

import type { PostContent } from '@mention/shared-types';
import { closePostgres, connectPostgres } from '../../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  seedPost,
} from '../../helpers/federationFixtures';
import { followService } from '../../../connectors/activitypub/follow.service';

const ISO = '2024-01-02T03:04:05.000Z';
const QUOTED_URI = 'https://remote.example/users/bob/statuses/99';
const QUOTE_LINK_REL = 'https://misskey-hub.net/ns#_misskey_quote';

function body(text: string): PostContent {
  return { variants: [{ source: 'author', text }] };
}

const scope = federationScope('quote-federation');

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('buildCreateNoteActivity — quote → FEP-044f / FEP-e232 quote fields + Link tag', () => {
  it('emits quote/quoteUri/quoteUrl/_misskey_quote = the quoted canonical id and a Link tag', () => {
    const activity = followService.buildCreateNoteActivity(
      { id: 'q1', content: body('check this out'), createdAt: ISO },
      'alice',
      undefined,
      undefined,
      undefined,
      { uri: QUOTED_URI },
    );
    const object = activity.object as Record<string, unknown>;

    // All four quote surfaces carry the SAME quoted-object canonical id.
    expect(object.quote).toBe(QUOTED_URI);
    expect(object.quoteUri).toBe(QUOTED_URI);
    expect(object.quoteUrl).toBe(QUOTED_URI);
    expect(object._misskey_quote).toBe(QUOTED_URI);

    // The FEP-e232 quote Link tag points at the quoted object as AP JSON.
    const tags = object.tag as Array<Record<string, string>>;
    expect(tags).toContainEqual({
      type: 'Link',
      mediaType: 'application/activity+json',
      href: QUOTED_URI,
      name: `RE: ${QUOTED_URI}`,
      rel: QUOTE_LINK_REL,
    });

    // The commentary is a normal Note body; the quoted URL is NOT appended into
    // `content` (structured fields only — no double-render on quote-aware servers).
    expect(object.content).toBe('<p>check this out</p>');
    expect(String(object.content)).not.toContain(QUOTED_URI);

    // It is still a plain Note (a quote is not a poll).
    expect(object.type).toBe('Note');
  });

  it('a non-quote post emits NONE of the quote fields and no Link tag', () => {
    const activity = followService.buildCreateNoteActivity(
      { id: 'p1', content: body('just a post'), createdAt: ISO },
      'alice',
    );
    const object = activity.object as Record<string, unknown>;

    expect(object.quote).toBeUndefined();
    expect(object.quoteUri).toBeUndefined();
    expect(object.quoteUrl).toBeUndefined();
    expect(object._misskey_quote).toBeUndefined();

    const tags = (object.tag as Array<Record<string, string>> | undefined) ?? [];
    expect(tags.some((t) => t.type === 'Link')).toBe(false);
  });
});

describe('resolveQuoteContext — reuses resolveFederationTarget', () => {
  it('resolves a FEDERATED quoted post to its remote federation.activityId', async () => {
    // A MIRRORED original: it already has a canonical AP id upstream, so the
    // quote must point at that rather than minting a Mention URL for it.
    const quoted = await seedPost(scope, {
      oxyUserId: scope.user('remote-owner'),
      federation: { activityId: QUOTED_URI, actorUri: `${scope.origin}/users/bob` },
    });

    const context = await followService.resolveQuoteContext({
      id: 'q1',
      content: body('quoting a remote post'),
      createdAt: ISO,
      quoteOf: quoted.id,
    });

    expect(context).toEqual({ uri: QUOTED_URI });
    // A federated quoted post never needs an Oxy username lookup.
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('resolves a LOCAL quoted post to its minted /ap/users/<owner>/posts/<id> uri', async () => {
    // No `federation` → local original; the owner username is resolved via Oxy.
    const owner = scope.user('owner1');
    const quoted = await seedPost(scope, { oxyUserId: owner });
    getUserById.mockResolvedValue({ username: 'bob' });

    const context = await followService.resolveQuoteContext({
      id: 'q1',
      content: body('quoting a local post'),
      createdAt: ISO,
      quoteOf: quoted.id,
    });

    // The minted URI carries the quoted post's REAL id — a uuid v7 since the
    // cutover, which is why nothing on this path may validate an ObjectId.
    expect(context).toEqual({
      uri: `https://mention.earth/ap/users/bob/posts/${quoted.id}`,
    });
    expect(getUserById).toHaveBeenCalledWith(owner);
  });

  it('returns null when the post is not a quote', async () => {
    const context = await followService.resolveQuoteContext({
      id: 'p1',
      content: body('no quote here'),
      createdAt: ISO,
    });

    expect(context).toBeNull();
  });

  it('returns null (no quote context) for a boost — a boost carries boostOf, never quoteOf', async () => {
    const context = await followService.resolveQuoteContext({
      id: 'b1',
      content: body(''),
      createdAt: ISO,
      boostOf: 'original-1',
    });

    expect(context).toBeNull();
  });

  it('returns null when the quoted post is unresolvable (fail-soft, still federate the commentary)', async () => {
    // No row for this id — a quoted post that was deleted between the write and
    // the fan-out. The commentary still federates; only the quote fields drop.
    const context = await followService.resolveQuoteContext({
      id: 'q1',
      content: body('quoting a deleted post'),
      createdAt: ISO,
      quoteOf: '019fffff-ffff-7fff-bfff-ffffffffffff',
    });

    expect(context).toBeNull();
  });
});

describe('resolveQuoteContextByPost — batched + deduped', () => {
  it('keys each quote context by post id, dedupes a shared quoted post, and omits non-quote posts', async () => {
    // Both quote posts reference the SAME quoted original.
    const shared = await seedPost(scope, {
      oxyUserId: scope.user('remote-owner'),
      federation: { activityId: QUOTED_URI, actorUri: `${scope.origin}/users/bob` },
    });

    const map = await followService.resolveQuoteContextByPost([
      { id: 'q1', content: body('quote a'), createdAt: ISO, quoteOf: shared.id },
      { id: 'q2', content: body('quote b'), createdAt: ISO, quoteOf: shared.id },
      { id: 'p3', content: body('plain post'), createdAt: ISO },
    ]);

    expect(map.get('q1')).toEqual({ uri: QUOTED_URI });
    expect(map.get('q2')).toEqual({ uri: QUOTED_URI });
    expect(map.has('p3')).toBe(false);
  });

  it('returns an empty map when no post is a quote', async () => {
    const map = await followService.resolveQuoteContextByPost([
      { id: 'p1', content: body('a'), createdAt: ISO },
      { id: 'p2', content: body('b'), createdAt: ISO },
    ]);

    expect(map.size).toBe(0);
  });
});
