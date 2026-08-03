/**
 * WHICH LINKS IN A BODY COMPETE TO BECOME MENTIONS.
 *
 * Every case is driven by a real body string, because the thing being asserted is
 * what the author typed becoming what the server stores.
 *
 * This module decides CANDIDACY and BUDGET, and nothing else. It does not decide
 * who a link names — the server does, from stored identities, and the composer
 * asks it (`hooks/useProfileLinkMentions`). So "is a candidate" here never means
 * "will be announced": a candidate the server resolves to nobody stays an
 * ordinary link on screen, and the assertions for THAT live in the summary's own
 * suite where the answer exists.
 *
 * What must hold here is narrower and sharper: the set of links competing for the
 * body's slots has to be the SAME set the write boundary spends its slots on. A
 * gate that admits fewer does not merely under-report — it reorders the budget,
 * and can hand the author the name of the one person their post will NOT mention.
 */

import {
  MAX_MENTIONS_PER_POST,
  MAX_PROFILE_LINKS_PER_BODY,
} from '@mention/shared-types/mentions';
import { composerProfileLinks } from '../composerProfileLinks';
import { ownProfileLinkHandle } from '../ownProfileLinks';

const NO_MENTIONS: string[] = [];

/** `MAX_MENTIONS_PER_POST` distinct authorized ids, each with a placeholder. */
function fullMentionRegistry(): { text: string; ids: string[] } {
  const ids = Array.from({ length: MAX_MENTIONS_PER_POST }, (_, index) => `id${index}`);
  return { text: ids.map((id) => `[mention:${id}]`).join(' '), ids };
}

describe('a profile-shaped link is a candidate, wherever it is served', () => {
  it('takes a profile URL on this instance', () => {
    expect(composerProfileLinks(['look at https://mention.earth/@alice'], NO_MENTIONS)).toEqual([
      'https://mention.earth/@alice',
    ]);
  });

  it('takes the actor URI form too — the same person, a different spelling', () => {
    expect(composerProfileLinks(['https://mention.earth/ap/users/alice'], NO_MENTIONS)).toEqual([
      'https://mention.earth/ap/users/alice',
    ]);
  });

  it('takes a profile on ANOTHER fediverse host', () => {
    // The write boundary folds this one too whenever we already store the actor,
    // so it competes for the same budget. Whether it is announced is the
    // server's answer, not this module's.
    expect(composerProfileLinks(['https://mastodon.social/@alice'], NO_MENTIONS)).toEqual([
      'https://mastodon.social/@alice',
    ]);
  });

  it('takes the `/users/<id>` form every Mastodon-family host publishes', () => {
    expect(composerProfileLinks(['https://mastodon.social/users/alice'], NO_MENTIONS)).toEqual([
      'https://mastodon.social/users/alice',
    ]);
  });

  it('keeps the sentence punctuation out of the link', () => {
    expect(composerProfileLinks(['ask https://mention.earth/@alice.'], NO_MENTIONS)).toEqual([
      'https://mention.earth/@alice',
    ]);
  });

  it('recognises the bare www form somebody pastes without a scheme', () => {
    expect(composerProfileLinks(['www.mention.earth/@alice'], NO_MENTIONS)).toEqual([
      'https://www.mention.earth/@alice',
    ]);
  });

  it('reads every rendition of the post, not just the primary body', () => {
    expect(
      composerProfileLinks(['hello', 'hola https://mention.earth/@alice'], NO_MENTIONS),
    ).toEqual(['https://mention.earth/@alice']);
  });

  it('takes a lookalike host, and leaves the naming to the server', () => {
    // `mention.earth.evil.test/@alice` is not ours — the host gate says so — but
    // it IS profile-shaped, so the write boundary spends a slot asking about it
    // and so does this. It resolves to nobody unless we genuinely store that
    // actor, which is the server's call and not a syntactic one.
    expect(composerProfileLinks(['https://mention.earth.evil.test/@alice'], NO_MENTIONS)).toEqual([
      'https://mention.earth.evil.test/@alice',
    ]);
  });
});

describe('a link that could never name anybody is not a candidate', () => {
  it('leaves an ordinary link alone', () => {
    expect(
      composerProfileLinks(
        ['https://mention.earth/p/abc123 and https://example.com/alice'],
        NO_MENTIONS,
      ),
    ).toEqual([]);
  });

  it('leaves a subpage of a profile alone — it is a different document', () => {
    expect(composerProfileLinks(['https://mention.earth/@alice/followers'], NO_MENTIONS)).toEqual(
      [],
    );
    expect(composerProfileLinks(['https://mastodon.social/@alice/media'], NO_MENTIONS)).toEqual([]);
  });

  it('leaves text that is not a URL alone', () => {
    expect(composerProfileLinks(['mention.earth @alice', ''], NO_MENTIONS)).toEqual([]);
  });
});

describe('the composer spends the same budget the write boundary has', () => {
  it(`stops at ${MAX_PROFILE_LINKS_PER_BODY} links, matching the per-body cap`, () => {
    const text = Array.from(
      { length: MAX_PROFILE_LINKS_PER_BODY + 3 },
      (_, index) => `https://mention.earth/@user${index}`,
    ).join(' ');

    const links = composerProfileLinks([text], NO_MENTIONS);

    expect(links).toHaveLength(MAX_PROFILE_LINKS_PER_BODY);
    expect(links[0]).toBe('https://mention.earth/@user0');
    expect(links.at(-1)).toBe(`https://mention.earth/@user${MAX_PROFILE_LINKS_PER_BODY - 1}`);
  });

  /**
   * THE CASE THE NARROW GATE GOT WRONG, kept because it is the one that misled an
   * author rather than merely under-reporting to them.
   *
   * A gate admitting only our own host let these eight foreign links through
   * unbudgeted and then named `@ours` — while the write boundary, which counts
   * them, spends the whole ceiling on the eight it meets first and drops ours. So
   * the row named the one person the post would NOT mention. Now the same eight
   * fill the budget here too, and `@ours` is not among the candidates at all.
   */
  it('lets foreign profile links use up the budget, as the write boundary does', () => {
    const foreign = Array.from(
      { length: MAX_PROFILE_LINKS_PER_BODY },
      (_, index) => `https://mastodon.social/@user${index}`,
    );
    const body = `${foreign.join(' ')} https://mention.earth/@ours`;

    const links = composerProfileLinks([body], NO_MENTIONS);

    expect(links).toEqual(foreign);
    expect(links).not.toContain('https://mention.earth/@ours');
  });

  it('claims nothing once the picked mentions have used the whole ceiling', () => {
    const { text, ids } = fullMentionRegistry();

    expect(composerProfileLinks([`${text} https://mention.earth/@alice`], ids)).toEqual([]);
  });

  it('takes only the headroom the picked mentions leave', () => {
    const { ids } = fullMentionRegistry();
    const oneFewer = ids.slice(0, MAX_MENTIONS_PER_POST - 1);
    const body = `${oneFewer.map((id) => `[mention:${id}]`).join(' ')} https://mention.earth/@alice https://mention.earth/@bob`;

    expect(composerProfileLinks([body], oneFewer)).toEqual(['https://mention.earth/@alice']);

    // The same two links with room to spare take both slots, so the assertion
    // above is measuring the headroom and not a cap on links generally.
    expect(
      composerProfileLinks(
        ['https://mention.earth/@alice https://mention.earth/@bob'],
        NO_MENTIONS,
      ),
    ).toHaveLength(2);
  });

  it('ignores an id the author deleted from the body — it is not using room', () => {
    // Authorized but with no placeholder left behind it: the write boundary
    // measures headroom the same way and drops it too.
    const ghosts = Array.from({ length: MAX_MENTIONS_PER_POST }, (_, index) => `gone${index}`);

    expect(composerProfileLinks(['https://mention.earth/@alice'], ghosts)).toEqual([
      'https://mention.earth/@alice',
    ]);
  });

  it('counts each spelling of a profile separately, as the server pays for each', () => {
    expect(
      composerProfileLinks(
        ['https://mention.earth/@alice https://mention.earth/ap/users/alice'],
        NO_MENTIONS,
      ),
    ).toEqual([
      'https://mention.earth/@alice',
      'https://mention.earth/ap/users/alice',
    ]);
  });

  it('does not spend a slot twice on the same URL written twice', () => {
    expect(
      composerProfileLinks(
        ['https://mention.earth/@alice', 'https://mention.earth/@alice'],
        NO_MENTIONS,
      ),
    ).toEqual(['https://mention.earth/@alice']);
  });
});

describe('a percent-encoded handle no longer has two readings', () => {
  /**
   * THIS BLOCK USED TO PIN A DIVERGENCE. It now pins its absence.
   *
   * The composer used to read a handle out of the URL itself, decoding it,
   * while the write boundary handed the verbatim path segment to its resolver —
   * so `…/@caf%C3%A9` was announced here and not stored there. The endpoint takes
   * the URL, so there is no longer a second place the characters are read into a
   * handle at all, and the disagreement is gone by construction rather than
   * fixed twice.
   */
  it('passes the URL through untouched, for the one side that reads it to answer', () => {
    expect(composerProfileLinks(['https://mention.earth/@caf%C3%A9'], NO_MENTIONS)).toEqual([
      'https://mention.earth/@caf%C3%A9',
    ]);
  });

  it('is still a candidate when the segment does not decode — the server decides', () => {
    // These were dropped here when this module derived a handle. It no longer
    // does, so they reach the one side that can say whether anybody holds them,
    // which answers `null` and leaves them links.
    expect(composerProfileLinks(['https://mention.earth/@%E0%A4%A'], NO_MENTIONS)).toEqual([
      'https://mention.earth/@%E0%A4%A',
    ]);
  });

  it('still refuses a segment carrying a path separator — that is a subpage', () => {
    expect(composerProfileLinks(['https://mention.earth/@a/b'], NO_MENTIONS)).toEqual([]);
  });
});

describe('the host gate still decides what the READER sees as a mention', () => {
  it('is unchanged, and is a different question from candidacy', () => {
    // The linkifier re-labels a URL as a mention only for our own host, because
    // there the mention and the link have the same destination. Candidacy above
    // is wider on purpose: it mirrors what the write boundary BUDGETS, not what
    // the reading surface renders.
    expect(ownProfileLinkHandle('https://mention.earth/@alice')).toBe('alice');
    expect(ownProfileLinkHandle('https://mastodon.social/@alice')).toBeUndefined();
  });
});
