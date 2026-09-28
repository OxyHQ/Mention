import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A PROFILE LINK PASTED INTO A POST BECOMES A MENTION AT WRITE TIME.
 *
 * The inbound-federation ingest has always folded an unclaimed profile link in an
 * incoming Note into that note's real mentions (`apMentions.addContentProfileMentions`).
 * A post composed HERE did not: the native controller took `mentions` straight off
 * the request body, so it only ever saw what the composer's picker had sent. Same
 * URL, two answers, decided by which side of the wire the author was on.
 *
 * These pin the write-boundary half of the one mechanism that now answers it for
 * both. The rules under test, each of which is a decision rather than an
 * implementation detail:
 *
 *  - a resolved link is REWRITTEN in the body into `[mention:<id>]` and its id is
 *    authorized — the id alone would be inert, because `reconcileMentionIds`
 *    drops any id with no placeholder behind it;
 *  - a link we cannot resolve STAYS A LINK — a mention pointing at nobody renders
 *    as inert text where a working link used to be;
 *  - resolution is LOOKUP-ONLY, never a fetch of the pasted URL;
 *  - a URL that is not profile-shaped costs no I/O at all;
 *  - the profile-link source shares ONE per-post ceiling with the mentions the
 *    body already carries.
 *
 * Mocking mirrors `connectors/activitypub/apProfileLinkMentions.test.ts`: the
 * stored-actor REPOSITORY (`db/federation/actorRepository`), the federation
 * `constants` (own-domain policy + Oxy user resolution) and the logger are
 * stubbed, so no network, DB or Oxy I/O runs.
 */

const mocks = vi.hoisted(() => ({
  isBlockedDomain: vi.fn((_host: string) => false),
  resolveOxyUser: vi.fn(),
  findActorByUri: vi.fn(),
  findActorByAcct: vi.fn(),
  createActor: vi.fn(),
  updateActor: vi.fn(),
}));

vi.mock('../../connectors/activitypub/constants', () => ({
  isBlockedDomain: mocks.isBlockedDomain,
  resolveOxyUser: mocks.resolveOxyUser,
}));
vi.mock('../../db/federation/actorRepository', () => ({
  findActorByUri: mocks.findActorByUri,
  findActorByAcct: mocks.findActorByAcct,
  upsertActor: mocks.createActor,
  setActorOxyUserId: mocks.updateActor,
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  MAX_MENTIONS_PER_POST,
  MAX_PROFILE_LINKS_PER_BODY,
} from '@mention/shared-types/mentions';
import { foldProfileLinkMentions } from '../../services/profileLinkMentions';

/** This instance's own web host, as the federation domain policy sees it. */
const OWN_HOST = 'mention.earth';
const ALICE_OXY_ID = 'oxy_alice_local';
const BOB_OXY_ID = 'oxy_bob_federated';

/**
 * Stub the stored-actor rows. Keyed exactly as the code looks them up: by actor
 * `uri` (the `/users/<id>` shape) and by `acct` (the `/@<user>` shape).
 *
 * TWO point lookups, not one disjunction — that is what the repository does, and
 * the acct read only happens when the uri read missed. Modelling it as two stubs
 * keeps that observable, which is what the `not.toHaveBeenCalled()` cases below
 * assert on.
 */
function stubStoredActors(rows: { uri?: Record<string, string>; acct?: Record<string, string> }): void {
  mocks.findActorByUri.mockImplementation(async (uri: string) =>
    rows.uri?.[uri] ? { oxyUserId: rows.uri[uri] } : null,
  );
  mocks.findActorByAcct.mockImplementation(async (acct: string) =>
    rows.acct?.[acct] ? { oxyUserId: rows.acct[acct] } : null,
  );
}

/** The single-body write shape every native controller hands the fold. */
function body(text: string): { text: string } {
  return { text };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Mirrors the real policy's `canonicalFederationHost` (`@oxy.so/federation`),
  // which lowercases and strips a leading `www.` on BOTH sides of the comparison
  // — a stub that only matched the bare host would report the `www.` spelling of
  // our own domain as somebody else's instance, which production does not.
  mocks.isBlockedDomain.mockImplementation(
    (host: string) => host.toLowerCase().replace(/^www\./, '') === OWN_HOST,
  );
  mocks.resolveOxyUser.mockResolvedValue(null);
  mocks.findActorByUri.mockResolvedValue(null);
  mocks.findActorByAcct.mockResolvedValue(null);
});

describe('a profile link on OUR OWN host', () => {
  beforeEach(() => {
    mocks.resolveOxyUser.mockImplementation(async (username: string) =>
      username === 'alice' ? { _id: ALICE_OXY_ID } : null,
    );
  });

  it('is rewritten into the placeholder the composer picker produces, and authorized', async () => {
    const content = body(`say hi to https://${OWN_HOST}/@alice about this`);

    const fold = await foldProfileLinkMentions(content, []);

    expect(content.text).toBe(`say hi to [mention:${ALICE_OXY_ID}] about this`);
    expect(fold.mentions).toEqual([ALICE_OXY_ID]);
    expect(fold.rewritten).toBe(true);
  });

  it('decodes a percent-encoded handle, so the screen and the store agree', async () => {
    // The composer's roster and the renderer both read `ownProfileUrlHandle`,
    // which decodes. This resolver used to pass the RAW path segment on, so
    // `…/@caf%C3%A9` asked Oxy for `caf%C3%A9`, missed, and left a link the
    // author had already been told would be a mention.
    mocks.resolveOxyUser.mockImplementation(async (username: string) =>
      username === 'café' ? { _id: ALICE_OXY_ID } : null,
    );
    const content = body(`hola https://${OWN_HOST}/@caf%C3%A9 que tal`);

    const fold = await foldProfileLinkMentions(content, []);

    expect(mocks.resolveOxyUser).toHaveBeenCalledWith('café');
    expect(fold.mentions).toEqual([ALICE_OXY_ID]);
  });

  it('never treats a MODERATION-blocked host as one of ours', async () => {
    // The branch used to key on `isBlockedDomain`, which is true for blocked
    // instances as well as for us — so this asked Oxy to resolve `alice` as one
    // of OUR users. Unreachable from ingest; reachable from a composed body.
    //
    // The stub has to say the host is BLOCKED for this to be the case it names:
    // the shared `beforeEach` only reports our own host, under which `poa.st` is
    // an ordinary remote instance and the old resolver reached the (correct)
    // remote arm. Blocked is the input that separates the two.
    mocks.isBlockedDomain.mockImplementation(
      (host: string) => ['poa.st', OWN_HOST].includes(host.toLowerCase().replace(/^www\./, '')),
    );
    const content = body(`see https://poa.st/@alice here`);

    const fold = await foldProfileLinkMentions(content, []);

    expect(mocks.resolveOxyUser).not.toHaveBeenCalled();
    expect(fold.mentions).toEqual([]);
    expect(content.text).toBe('see https://poa.st/@alice here');
  });

  it('never looks a URL on our OWN host up as somebody else’s stored actor', async () => {
    // Now that the local branch is selected by SHAPE, `isBlockedDomain` is what
    // keeps the own-host cases it does not match from falling through to the
    // remote arm. `/users/<name>` is exactly such a case: it is the Mastodon
    // actor-URI shape, so the stored-actor lookup answers for it — with a row
    // mirrored in for one of OUR OWN users — while our profiles live at `/@name`
    // and `/ap/users/name`. Resolving it would mint a mention of whoever that
    // stale row points at.
    stubStoredActors({ acct: { [`alice@${OWN_HOST}`]: BOB_OXY_ID } });
    const content = body(`read https://${OWN_HOST}/users/alice first`);

    const fold = await foldProfileLinkMentions(content, []);

    expect(mocks.resolveOxyUser).not.toHaveBeenCalled();
    expect(fold.mentions).toEqual([]);
    expect(content.text).toBe(`read https://${OWN_HOST}/users/alice first`);
  });

  it('leaves the prose punctuation that merely followed the link', async () => {
    const content = body(`talk to https://${OWN_HOST}/@alice.`);

    await foldProfileLinkMentions(content, []);

    expect(content.text).toBe(`talk to [mention:${ALICE_OXY_ID}].`);
  });

  it('recognises the scheme-less `www.` spelling as the same link', async () => {
    const content = body(`www.${OWN_HOST}/@alice wrote it`);

    const fold = await foldProfileLinkMentions(content, []);

    expect(content.text).toBe(`[mention:${ALICE_OXY_ID}] wrote it`);
    expect(fold.mentions).toEqual([ALICE_OXY_ID]);
  });

  it('rewrites EVERY occurrence while naming the person once', async () => {
    const content = body(`https://${OWN_HOST}/@alice and again https://${OWN_HOST}/@alice`);

    const fold = await foldProfileLinkMentions(content, []);

    expect(content.text).toBe(`[mention:${ALICE_OXY_ID}] and again [mention:${ALICE_OXY_ID}]`);
    expect(fold.mentions).toEqual([ALICE_OXY_ID]);
  });

  it('keeps the mentions the composer picker already sent', async () => {
    const content = body(`[mention:oxy_picked] see https://${OWN_HOST}/@alice`);

    const fold = await foldProfileLinkMentions(content, ['oxy_picked']);

    expect(fold.mentions).toEqual(['oxy_picked', ALICE_OXY_ID]);
  });

  it('adds nobody when the handle names no account here', async () => {
    const content = body(`https://${OWN_HOST}/@nobody-holds-this`);

    const fold = await foldProfileLinkMentions(content, []);

    expect(content.text).toBe(`https://${OWN_HOST}/@nobody-holds-this`);
    expect(fold.mentions).toEqual([]);
    expect(fold.rewritten).toBe(false);
  });
});

describe('a profile link on a FOREIGN fediverse host', () => {
  it('resolves through the actor rows we already store, exactly as the ingest does', async () => {
    stubStoredActors({ acct: { 'bob@mastodon.social': BOB_OXY_ID } });
    const content = body('quoting https://mastodon.social/@bob here');

    const fold = await foldProfileLinkMentions(content, []);

    expect(content.text).toBe(`quoting [mention:${BOB_OXY_ID}] here`);
    expect(fold.mentions).toEqual([BOB_OXY_ID]);
  });

  it('resolves the `/users/<id>` actor-URI spelling too', async () => {
    stubStoredActors({ uri: { 'https://mastodon.social/users/bob': BOB_OXY_ID } });
    const content = body('see https://mastodon.social/users/bob');

    await foldProfileLinkMentions(content, []);

    expect(content.text).toBe(`see [mention:${BOB_OXY_ID}]`);
  });

  it('STAYS A LINK when no stored actor names it', async () => {
    const content = body('see https://mastodon.social/@a-stranger-we-never-synced');

    const fold = await foldProfileLinkMentions(content, []);

    expect(content.text).toBe('see https://mastodon.social/@a-stranger-we-never-synced');
    expect(fold.mentions).toEqual([]);
    expect(fold.rewritten).toBe(false);
  });

  it('never dereferences the pasted URL, and never creates an actor row for it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const content = body('see https://mastodon.social/@a-stranger-we-never-synced');

    await foldProfileLinkMentions(content, []);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.createActor).not.toHaveBeenCalled();
    expect(mocks.updateActor).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('leaves the link alone when the lookup throws, without failing the write', async () => {
    mocks.findActorByUri.mockImplementation(async () => {
      throw new Error('postgres is having a day');
    });
    const content = body('see https://mastodon.social/@bob');

    const fold = await foldProfileLinkMentions(content, []);

    expect(content.text).toBe('see https://mastodon.social/@bob');
    expect(fold.mentions).toEqual([]);
  });
});

describe('an ordinary link is not a mention', () => {
  it('is left untouched and costs no lookup at all', async () => {
    const content = body('read https://example.com/2026/an-article and tell me');

    const fold = await foldProfileLinkMentions(content, []);

    expect(content.text).toBe('read https://example.com/2026/an-article and tell me');
    expect(fold.mentions).toEqual([]);
    expect(mocks.findActorByUri).not.toHaveBeenCalled();
    expect(mocks.findActorByAcct).not.toHaveBeenCalled();
    expect(mocks.resolveOxyUser).not.toHaveBeenCalled();
  });

  it('does not treat a profile SUB-PAGE as the profile', async () => {
    const content = body('https://mastodon.social/@bob/followers');

    await foldProfileLinkMentions(content, []);

    expect(content.text).toBe('https://mastodon.social/@bob/followers');
    expect(mocks.findActorByUri).not.toHaveBeenCalled();
    expect(mocks.findActorByAcct).not.toHaveBeenCalled();
  });

  it('does no work at all for a body with no links', async () => {
    const content = body('just some words about nothing in particular');

    const fold = await foldProfileLinkMentions(content, []);

    expect(fold.rewritten).toBe(false);
    expect(mocks.findActorByUri).not.toHaveBeenCalled();
    expect(mocks.findActorByAcct).not.toHaveBeenCalled();
  });
});

describe('the per-post ceiling is shared with the mentions the body already carries', () => {
  /** `count` distinct, individually resolvable foreign profile links. */
  function manyProfileLinks(count: number): { text: string; ids: string[] } {
    const ids = Array.from({ length: count }, (_, index) => `oxy_remote_${index}`);
    const acct: Record<string, string> = {};
    ids.forEach((id, index) => {
      acct[`user${index}@mastodon.social`] = id;
    });
    stubStoredActors({ acct });
    return {
      text: ids.map((_, index) => `https://mastodon.social/@user${index}`).join(' '),
      ids,
    };
  }

  it(`resolves at most ${MAX_PROFILE_LINKS_PER_BODY} links, leaving the rest as links`, async () => {
    const { text, ids } = manyProfileLinks(MAX_PROFILE_LINKS_PER_BODY + 1);
    const content = body(text);

    const fold = await foldProfileLinkMentions(content, []);

    expect(fold.mentions).toHaveLength(MAX_PROFILE_LINKS_PER_BODY);
    expect(fold.mentions).not.toContain(ids[MAX_PROFILE_LINKS_PER_BODY]);
    // The surplus link is untouched — the pre-existing behaviour for all of them.
    expect(content.text).toContain(`https://mastodon.social/@user${MAX_PROFILE_LINKS_PER_BODY}`);
  });

  it('spends NO lookup when the body is already at the per-post mention ceiling', async () => {
    const carried = Array.from({ length: MAX_MENTIONS_PER_POST }, (_, i) => `oxy_carried_${i}`);
    const content = body(
      `${carried.map((id) => `[mention:${id}]`).join(' ')} https://mastodon.social/@bob`,
    );

    const fold = await foldProfileLinkMentions(content, carried);

    expect(mocks.findActorByUri).not.toHaveBeenCalled();
    expect(mocks.findActorByAcct).not.toHaveBeenCalled();
    expect(fold.mentions).toEqual(carried);
    expect(content.text).toContain('https://mastodon.social/@bob');
  });
});

describe('which renditions of a multilingual body are rewritten', () => {
  beforeEach(() => {
    mocks.resolveOxyUser.mockImplementation(async (username: string) =>
      username === 'alice' ? { _id: ALICE_OXY_ID } : null,
    );
  });

  it('rewrites every AUTHOR variant and leaves the machine translations alone', async () => {
    const content = {
      variants: [
        { source: 'author', tag: 'en', text: `hi https://${OWN_HOST}/@alice` },
        { source: 'author', tag: 'es', text: `hola https://${OWN_HOST}/@alice` },
        { source: 'machine', tag: 'fr', text: `salut https://${OWN_HOST}/@alice` },
      ],
    };

    const fold = await foldProfileLinkMentions(content, []);

    expect(content.variants[0].text).toBe(`hi [mention:${ALICE_OXY_ID}]`);
    expect(content.variants[1].text).toBe(`hola [mention:${ALICE_OXY_ID}]`);
    // A machine translation never creates a recipient, so it is never a source
    // the mention allowlist is read from — and never one it is written back to.
    expect(content.variants[2].text).toBe(`salut https://${OWN_HOST}/@alice`);
    expect(fold.mentions).toEqual([ALICE_OXY_ID]);
  });
});

/**
 * A TYPED HANDLE IS A MENTION TOO. `@alice` written by hand, without picking her
 * from the composer's list, used to be stored as prose: no mention rendered and
 * alice was never notified, while the very same name picked from the list was a
 * mention. Same word, two answers, decided by how the author happened to enter it.
 */
describe('a handle typed by hand', () => {
  beforeEach(() => {
    mocks.resolveOxyUser.mockImplementation(async (username: string) =>
      username.toLowerCase() === 'alice' ? { _id: ALICE_OXY_ID } : null,
    );
  });

  it('becomes the placeholder the picker produces, and is authorized', async () => {
    const content = body('hola @alice.');

    const fold = await foldProfileLinkMentions(content, []);

    expect(mocks.resolveOxyUser).toHaveBeenCalledWith('alice');
    expect(content.text).toBe(`hola [mention:${ALICE_OXY_ID}].`);
    expect(fold.mentions).toEqual([ALICE_OXY_ID]);
    expect(fold.rewritten).toBe(true);
  });

  it('is looked up once however often, and in whatever case, it is written', async () => {
    const content = body('@Alice and @alice again');

    const fold = await foldProfileLinkMentions(content, []);

    expect(mocks.resolveOxyUser).toHaveBeenCalledTimes(1);
    expect(content.text).toBe(`[mention:${ALICE_OXY_ID}] and [mention:${ALICE_OXY_ID}] again`);
    expect(fold.mentions).toEqual([ALICE_OXY_ID]);
  });

  it('stays text when nobody holds that name', async () => {
    const content = body('hola @nadie');

    const fold = await foldProfileLinkMentions(content, []);

    expect(content.text).toBe('hola @nadie');
    expect(fold.mentions).toEqual([]);
    expect(fold.rewritten).toBe(false);
  });

  it('resolves `@alice@<our host>` as our own user', async () => {
    const content = body(`hi @alice@${OWN_HOST}`);

    const fold = await foldProfileLinkMentions(content, []);

    expect(mocks.findActorByAcct).not.toHaveBeenCalled();
    expect(content.text).toBe(`hi [mention:${ALICE_OXY_ID}]`);
    expect(fold.mentions).toEqual([ALICE_OXY_ID]);
  });

  it('resolves a remote handle only to an actor we already store — never fetched', async () => {
    stubStoredActors({ acct: { 'bob@mastodon.social': BOB_OXY_ID } });
    const content = body('cc @Bob@mastodon.social and @carol@mastodon.social');

    const fold = await foldProfileLinkMentions(content, []);

    expect(mocks.findActorByAcct).toHaveBeenCalledWith('bob@mastodon.social');
    expect(mocks.resolveOxyUser).not.toHaveBeenCalled();
    expect(content.text).toBe(`cc [mention:${BOB_OXY_ID}] and @carol@mastodon.social`);
    expect(fold.mentions).toEqual([BOB_OXY_ID]);
  });

  it('names nobody on a moderation-blocked host', async () => {
    mocks.isBlockedDomain.mockImplementation(
      (host: string) => ['poa.st', OWN_HOST].includes(host.toLowerCase()),
    );
    stubStoredActors({ acct: { 'alice@poa.st': BOB_OXY_ID } });
    const content = body('hey @alice@poa.st');

    const fold = await foldProfileLinkMentions(content, []);

    expect(mocks.findActorByAcct).not.toHaveBeenCalled();
    expect(mocks.resolveOxyUser).not.toHaveBeenCalled();
    expect(content.text).toBe('hey @alice@poa.st');
    expect(fold.mentions).toEqual([]);
  });

  it('leaves a picked mention, an email address and a handle inside a URL alone', async () => {
    const content = body(
      `[mention:${ALICE_OXY_ID}] write to alice@example.com or see https://example.com/@alice`,
    );

    const fold = await foldProfileLinkMentions(content, [ALICE_OXY_ID]);

    expect(mocks.resolveOxyUser).not.toHaveBeenCalled();
    expect(fold.rewritten).toBe(false);
    expect(fold.mentions).toEqual([ALICE_OXY_ID]);
  });

  it('spends at most MAX_PROFILE_LINKS_PER_BODY lookups on one body', async () => {
    const names = Array.from({ length: MAX_PROFILE_LINKS_PER_BODY + 4 }, (_, i) => `user${i}`);
    const content = body(names.map((name) => `@${name}`).join(' '));

    await foldProfileLinkMentions(content, []);

    expect(mocks.resolveOxyUser).toHaveBeenCalledTimes(MAX_PROFILE_LINKS_PER_BODY);
  });

  it('shares the per-post ceiling with the mentions the body already carries', async () => {
    const carried = Array.from({ length: MAX_MENTIONS_PER_POST }, (_, i) => `oxy_carried_${i}`);
    const content = body(`${carried.map((id) => `[mention:${id}]`).join(' ')} @alice`);

    const fold = await foldProfileLinkMentions(content, carried);

    expect(mocks.resolveOxyUser).not.toHaveBeenCalled();
    expect(fold.mentions).toEqual(carried);
    expect(content.text).toContain('@alice');
  });

  it('leaves a handle whose lookup throws as text, and still folds the rest', async () => {
    mocks.resolveOxyUser.mockImplementation(async (username: string) => {
      if (username === 'broken') throw new Error('oxy down');
      return username === 'alice' ? { _id: ALICE_OXY_ID } : null;
    });
    const content = body('@broken and @alice');

    const fold = await foldProfileLinkMentions(content, []);

    expect(content.text).toBe(`@broken and [mention:${ALICE_OXY_ID}]`);
    expect(fold.mentions).toEqual([ALICE_OXY_ID]);
  });

  it('folds a profile link and a typed handle in the same body', async () => {
    stubStoredActors({ acct: { 'bob@mastodon.social': BOB_OXY_ID } });
    const content = body('https://mastodon.social/@bob meet @alice');

    const fold = await foldProfileLinkMentions(content, []);

    expect(content.text).toBe(`[mention:${BOB_OXY_ID}] meet [mention:${ALICE_OXY_ID}]`);
    expect(fold.mentions.sort()).toEqual([ALICE_OXY_ID, BOB_OXY_ID].sort());
  });
});
