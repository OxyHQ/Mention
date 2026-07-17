import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Batched, BOUNDED outbox @mention resolution (`resolveInboundMentionsForNotes`).
 *
 * The outbox backfill imports a whole PAGE of Notes in one raw `insertMany` pass,
 * bypassing the inbox `Create` path — so it never ran the mention resolver and
 * federated outbox-imported notes kept their @mentions as dead plain text. This
 * batch resolver closes that gap while staying bounded: every DISTINCT mentioned
 * actor across the page is fetched-and-created AT MOST once, in capped-concurrency
 * batches, each remote resolution capped by a per-actor timeout. These pin:
 *   - a mentioned actor shared by two notes is resolved ONCE (no per-note N+1);
 *   - each note's content anchor is rewritten to the `[mention:<id>]` placeholder
 *     and its `ids` allowlist carries the resolved id;
 *   - a slow/unresponsive actor TIMES OUT → its mention stays bare text, and the
 *     whole batch still resolves (never hangs — the prior re-ingest hang);
 *   - a throwing resolve leaves that one mention unresolved without aborting the
 *     rest of the batch.
 *
 * `actor.service` and `constants` are mocked so no network / DB / Oxy I/O runs;
 * the rest of the module graph (`bridgy`, `apLanguage`, `apSchemas`, `helpers`
 * `runWithTimeout`) is pure.
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
  resolveInboundMentionsForNotes,
  type ResolvedInboundMentions,
} from '../../../connectors/activitypub/apMentions';

/** Assert the batch produced a resolution for `note` and return it (no `!`). */
function resolutionFor(
  byNote: Map<Record<string, unknown>, ResolvedInboundMentions>,
  note: Record<string, unknown>,
): ResolvedInboundMentions {
  const resolved = byNote.get(note);
  if (!resolved) throw new Error('expected a resolution entry for the note');
  return resolved;
}

const REMOTE = 'https://mastodon.example';
const BOB_URI = `${REMOTE}/users/bob`;
const BOB_PROFILE = `${REMOTE}/@bob`;
const BOB_OXY_ID = 'oxy_bob';
const CAROL_URI = `${REMOTE}/users/carol`;
const CAROL_PROFILE = `${REMOTE}/@carol`;
const CAROL_OXY_ID = 'oxy_carol';

/** A Mastodon-style Note: tag href = actor URI, in-content anchor = profile page. */
function noteMentioning(actorUri: string, profileHref: string, name: string) {
  return {
    content: `<p>hi <a href="${profileHref}" class="u-url mention">${name}</a></p>`,
    tag: [{ type: 'Mention', href: actorUri, name: `${name}@mastodon.example` }],
  };
}

const OPTIONS = { concurrency: 3, perActorTimeoutMs: 20_000 };

beforeEach(() => {
  mocks.getOrFetchActor.mockReset();
  mocks.findExistingActor.mockReset();
  mocks.isBlockedDomain.mockReturnValue(false);
});

describe('resolveInboundMentionsForNotes (batched outbox mention resolution)', () => {
  it('resolves a distinct mention actor ONCE across a page and rewrites each note', async () => {
    mocks.getOrFetchActor.mockImplementation(async (uri: string) => {
      if (uri === BOB_URI) return { oxyUserId: BOB_OXY_ID };
      if (uri === CAROL_URI) return { oxyUserId: CAROL_OXY_ID };
      return null;
    });

    // Two notes mention @bob, one mentions @carol → 2 distinct actors.
    const noteA = noteMentioning(BOB_URI, BOB_PROFILE, '@bob');
    const noteB = noteMentioning(BOB_URI, BOB_PROFILE, '@bob');
    const noteC = noteMentioning(CAROL_URI, CAROL_PROFILE, '@carol');

    const byNote = await resolveInboundMentionsForNotes([noteA, noteB, noteC], OPTIONS);

    // Each DISTINCT actor fetched exactly once — never once per note.
    expect(mocks.getOrFetchActor).toHaveBeenCalledTimes(2);
    expect(mocks.getOrFetchActor).toHaveBeenCalledWith(BOB_URI);
    expect(mocks.getOrFetchActor).toHaveBeenCalledWith(CAROL_URI);

    // Per-note allowlist + placeholder rewrite.
    const a = resolutionFor(byNote, noteA);
    expect(a.ids).toEqual([BOB_OXY_ID]);
    expect(applyMentionPlaceholders(noteA, a.anchorMap).content).toBe(
      `<p>hi [mention:${BOB_OXY_ID}]</p>`,
    );
    expect(resolutionFor(byNote, noteB).ids).toEqual([BOB_OXY_ID]);
    const c = resolutionFor(byNote, noteC);
    expect(c.ids).toEqual([CAROL_OXY_ID]);
    expect(applyMentionPlaceholders(noteC, c.anchorMap).content).toBe(
      `<p>hi [mention:${CAROL_OXY_ID}]</p>`,
    );
  });

  it('times out a slow/unresponsive actor: mention stays bare text, batch never hangs', async () => {
    // @bob resolves fast; @carol never resolves → must be bounded by the timeout.
    mocks.getOrFetchActor.mockImplementation((uri: string) => {
      if (uri === BOB_URI) return Promise.resolve({ oxyUserId: BOB_OXY_ID });
      return new Promise(() => {
        /* never resolves — simulates an unresponsive remote instance */
      });
    });

    const noteBob = noteMentioning(BOB_URI, BOB_PROFILE, '@bob');
    const noteSlow = noteMentioning(CAROL_URI, CAROL_PROFILE, '@carol');

    // A tiny per-actor timeout so the never-resolving fetch is abandoned quickly.
    const byNote = await resolveInboundMentionsForNotes([noteBob, noteSlow], {
      concurrency: 3,
      perActorTimeoutMs: 10,
    });

    // @bob still resolved and rewrote; the unresponsive @carol is left bare text.
    expect(resolutionFor(byNote, noteBob).ids).toEqual([BOB_OXY_ID]);
    const slow = resolutionFor(byNote, noteSlow);
    expect(slow.ids).toEqual([]);
    expect(applyMentionPlaceholders(noteSlow, slow.anchorMap).content).toBe(noteSlow.content);
  });

  it('a throwing resolve leaves that mention unresolved without aborting the batch', async () => {
    mocks.getOrFetchActor.mockImplementation(async (uri: string) => {
      if (uri === BOB_URI) return { oxyUserId: BOB_OXY_ID };
      throw new Error('remote actor fetch blew up');
    });

    const noteBob = noteMentioning(BOB_URI, BOB_PROFILE, '@bob');
    const noteBad = noteMentioning(CAROL_URI, CAROL_PROFILE, '@carol');

    const byNote = await resolveInboundMentionsForNotes([noteBob, noteBad], OPTIONS);

    expect(resolutionFor(byNote, noteBob).ids).toEqual([BOB_OXY_ID]);
    const bad = resolutionFor(byNote, noteBad);
    expect(bad.ids).toEqual([]);
    expect(applyMentionPlaceholders(noteBad, bad.anchorMap).content).toBe(noteBad.content);
  });

  it('returns an empty map for an empty page (no resolution work)', async () => {
    const byNote = await resolveInboundMentionsForNotes([], OPTIONS);
    expect(byNote.size).toBe(0);
    expect(mocks.getOrFetchActor).not.toHaveBeenCalled();
  });
});
