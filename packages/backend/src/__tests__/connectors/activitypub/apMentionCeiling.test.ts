import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Per-note ceiling on inbound federated @mentions.
 *
 * A remote note's `tag` array is entirely author-controlled. Measured on the
 * reply-all pile-up thread at `annihilation.social` (1,870 posts pulled from the
 * origin's API): 28.9 mentions per post on average, 34 at most. Resolved unbounded,
 * ONE inbound note makes us fetch-and-create that many remote actors, store that
 * many ids, and hand that many placeholders to hydration — and every ancestor the
 * thread backfill imports pays the same cost again.
 *
 * These pin `MAX_MENTIONS_PER_POST` at the boundary (all resolved AT the ceiling;
 * exactly the ceiling one over), the fact that the surplus is never RESOLVED (so
 * the actor-fetch fan-out is bounded, not just the stored list), the kept set being
 * the note's own document order, the shared ceiling across tags + profile links,
 * the truncation log, and — the part that keeps truncation honest — that a dropped
 * mention degrades to plain text rather than leaking a raw `[mention:<id>]`
 * placeholder into the rendered body.
 *
 * Mocking mirrors `apProfileLinkMentions.test.ts`: `actor.service` + `constants` +
 * the `FederatedActor` model + `logger` are mocked, so no network, DB or Oxy I/O
 * runs and the rest of the graph is pure.
 */

const mocks = vi.hoisted(() => ({
  getOrFetchActor: vi.fn(),
  isBlockedDomain: vi.fn((_host: string) => false),
  resolveOxyUser: vi.fn(),
  findExistingActor: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/actor.service', () => ({
  actorService: { getOrFetchActor: mocks.getOrFetchActor },
}));
vi.mock('../../../connectors/activitypub/constants', () => ({
  isBlockedDomain: mocks.isBlockedDomain,
  resolveOxyUser: mocks.resolveOxyUser,
}));
/**
 * The profile-link resolver reaches ALREADY-STORED actor rows through the
 * repository. Doubled here rather than seeded: this suite's subject is the
 * per-note ceiling arithmetic, and its fixtures are up to 34 synthetic actors
 * per note — seeding them would be fixture cost with nothing riding on it, and
 * the repository's own behaviour is covered where it is written.
 */
vi.mock('../../../db/federation/actorRepository', () => ({
  findActorByUri: mocks.findExistingActor,
  findActorByAcct: mocks.findExistingActor,
}));
vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: mocks.loggerWarn, error: vi.fn(), debug: vi.fn() },
}));

import { MAX_MENTIONS_PER_POST as CEILING } from '@mention/shared-types/mentions';
import {
  applyMentionPlaceholders,
  resolveInboundMentions,
  resolveInboundMentionsForNotes,
} from '../../../connectors/activitypub/apMentions';
import { htmlToPlainText } from '../../../utils/federation/htmlToPlainText';

const REMOTE = 'https://pile.example';

/** Actor URI / oxy id / in-content anchor for mentioned user `n`. */
const actorUri = (n: number): string => `${REMOTE}/users/u${n}`;
const oxyId = (n: number): string => `oxy_u${n}`;
const anchor = (n: number): string =>
  `<span class="h-card"><a href="${REMOTE}/@u${n}" class="u-url mention">@<span>u${n}</span></a></span>`;

/**
 * A Mastodon-shaped reply-all note naming users `0..count-1`: one `Mention` tag
 * per user in the `tag` array, and the matching profile anchor in the body.
 */
const pileUpNote = (count: number): Record<string, unknown> => ({
  id: `${REMOTE}/statuses/1`,
  type: 'Note',
  content: `<p>${Array.from({ length: count }, (_, i) => anchor(i)).join(' ')} enough</p>`,
  tag: Array.from({ length: count }, (_, i) => ({
    type: 'Mention',
    href: actorUri(i),
    name: `@u${i}@pile.example`,
  })),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isBlockedDomain.mockReturnValue(false);
  mocks.findExistingActor.mockResolvedValue(null);
  // Every mentioned actor resolves — the ceiling, not resolution failure, is what
  // has to bound the result.
  mocks.getOrFetchActor.mockImplementation(async (uri: string) => {
    const n = /\/users\/u(\d+)$/.exec(uri)?.[1];
    return n === undefined ? null : { oxyUserId: oxyId(Number(n)) };
  });
});

describe('inbound mention ceiling — boundary', () => {
  it('holds the chosen value — moving it must be a deliberate act', () => {
    // The boundary cases below are parameterised on the constant and follow it
    // wherever it goes; this one pins it, so a quiet widening fails by name.
    expect(CEILING).toBe(16);
  });

  it(`resolves every mention AT the ceiling (${CEILING})`, async () => {
    const result = await resolveInboundMentions(pileUpNote(CEILING));

    expect(result.ids).toHaveLength(CEILING);
    expect(new Set(result.ids)).toEqual(
      new Set(Array.from({ length: CEILING }, (_, i) => oxyId(i))),
    );
    expect(mocks.getOrFetchActor).toHaveBeenCalledTimes(CEILING);
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it(`keeps exactly ${CEILING} one over the ceiling, in the note's own order`, async () => {
    const result = await resolveInboundMentions(pileUpNote(CEILING + 1));

    expect(result.ids).toHaveLength(CEILING);
    // Document order — the only ordering the origin committed to, and so the only
    // one that survives a redelivery / edit / re-ingest unchanged.
    expect(new Set(result.ids)).toEqual(
      new Set(Array.from({ length: CEILING }, (_, i) => oxyId(i))),
    );
    expect(result.ids).not.toContain(oxyId(CEILING));
  });

  it('bounds the ACTOR FETCH fan-out, not merely the stored list', async () => {
    // The measured worst case: 34 mentions on one note.
    await resolveInboundMentions(pileUpNote(34));

    expect(mocks.getOrFetchActor).toHaveBeenCalledTimes(CEILING);
  });

  it('drops the surplus to plain text, never to a raw placeholder', async () => {
    const note = pileUpNote(CEILING + 1);
    const result = await resolveInboundMentions(note);
    const rendered = htmlToPlainText(
      String(applyMentionPlaceholders(note, result.anchorMap).content),
    );

    // Kept mentions became placeholders that hydration will render as real links.
    expect(rendered).toContain(`[mention:${oxyId(0)}]`);
    // The dropped one is bare text — the same degradation an unresolved mention has
    // always produced. A placeholder with no id in `post.mentions` would render
    // LITERALLY to the reader (see PostHydrationService), so this is the property
    // that makes truncation safe rather than merely bounded.
    expect(rendered).not.toContain(`[mention:${oxyId(CEILING)}]`);
    expect(rendered).toContain(`@u${CEILING}`);
  });
});

describe('inbound mention ceiling — observability', () => {
  it('logs the truncation with both the mentioned and the kept count', async () => {
    await resolveInboundMentions(pileUpNote(34));

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      '[Federation] truncated inbound mentions above the per-post ceiling',
      { mentioned: 34, kept: CEILING },
    );
  });

  it('counts DISTINCT actors, so a repeated mention never trips the log', async () => {
    const note = pileUpNote(2);
    // The same actor tagged many times over — Mastodon does this when a handle
    // appears twice in the body.
    note.tag = Array.from({ length: 40 }, () => ({
      type: 'Mention',
      href: actorUri(0),
      name: '@u0@pile.example',
    }));

    const result = await resolveInboundMentions(note);

    expect(result.ids).toEqual([oxyId(0)]);
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });
});

describe('inbound mention ceiling — shared across tags and profile links', () => {
  it('spends no profile-link lookups on a tag-saturated note', async () => {
    const note = pileUpNote(CEILING);
    // A bare profile link with no Mention tag behind it, appended to a note whose
    // tags already fill the ceiling. There is no headroom, so it must not even be
    // looked up — the two mention sources share ONE per-post budget.
    note.content = `${String(note.content)} <a href="${REMOTE}/@stranger">@stranger</a>`;

    const result = await resolveInboundMentions(note);

    expect(result.ids).toHaveLength(CEILING);
    expect(mocks.findExistingActor).not.toHaveBeenCalled();
  });

  it('still resolves a profile link when the tags left headroom', async () => {
    mocks.findExistingActor.mockResolvedValue({ oxyUserId: 'oxy_stranger' });
    const note = pileUpNote(CEILING - 1);
    note.content = `${String(note.content)} <a href="${REMOTE}/@stranger">@stranger</a>`;

    const result = await resolveInboundMentions(note);

    expect(result.ids).toHaveLength(CEILING);
    expect(result.ids).toContain('oxy_stranger');
  });
});

describe('inbound mention ceiling — batched outbox path', () => {
  it('resolves only the capped set per note across a page', async () => {
    // Two pile-up notes naming DISTINCT users, so no cross-note dedup can mask the
    // per-note cap: the union resolved for the page must be 2 x the ceiling, not
    // 2 x 34.
    const first = pileUpNote(34);
    const second = pileUpNote(34);
    second.id = `${REMOTE}/statuses/2`;
    second.tag = Array.from({ length: 34 }, (_, i) => ({
      type: 'Mention',
      href: actorUri(100 + i),
      name: `@u${100 + i}@pile.example`,
    }));

    const byNote = await resolveInboundMentionsForNotes([first, second], {
      concurrency: 4,
      perActorTimeoutMs: 1000,
    });

    expect(byNote.get(first)?.ids).toHaveLength(CEILING);
    expect(byNote.get(second)?.ids).toHaveLength(CEILING);
    expect(mocks.getOrFetchActor).toHaveBeenCalledTimes(2 * CEILING);
  });
});
