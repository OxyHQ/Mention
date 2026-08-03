/**
 * The composer's half of "a pasted profile link is a mention".
 *
 * Every case here is driven by a real body string, because the thing being
 * asserted is what the author typed becoming what the server stores. The cases
 * that matter most are the ones where the answer is NOBODY: the composer must
 * never name somebody the write boundary will not.
 */

import { MAX_MENTIONS_PER_POST } from '@mention/shared-types/mentions';
import {
  composerProfileLinks,
  MAX_PROFILE_LINKS_PER_BODY,
} from '../composerProfileLinks';
import { ownProfileLinkHandle } from '../ownProfileLinks';

const NO_MENTIONS: string[] = [];

/** `MAX_MENTIONS_PER_POST` distinct authorized ids, each with a placeholder. */
function fullMentionRegistry(): { text: string; ids: string[] } {
  const ids = Array.from({ length: MAX_MENTIONS_PER_POST }, (_, index) => `id${index}`);
  return { text: ids.map((id) => `[mention:${id}]`).join(' '), ids };
}

describe('a profile link on this instance is a mention candidate', () => {
  it('names the handle a pasted profile URL points at', () => {
    expect(composerProfileLinks(['look at https://mention.earth/@alice'], NO_MENTIONS)).toEqual([
      { url: 'https://mention.earth/@alice', handle: 'alice' },
    ]);
  });

  it('reads the actor URI form too — the same person, a different spelling', () => {
    expect(composerProfileLinks(['https://mention.earth/ap/users/alice'], NO_MENTIONS)).toEqual([
      { url: 'https://mention.earth/ap/users/alice', handle: 'alice' },
    ]);
  });

  it('keeps the sentence punctuation out of the link', () => {
    expect(composerProfileLinks(['ask https://mention.earth/@alice.'], NO_MENTIONS)).toEqual([
      { url: 'https://mention.earth/@alice', handle: 'alice' },
    ]);
  });

  it('recognises the bare www form somebody pastes without a scheme', () => {
    expect(composerProfileLinks(['www.mention.earth/@alice'], NO_MENTIONS)).toEqual([
      { url: 'https://www.mention.earth/@alice', handle: 'alice' },
    ]);
  });

  it('reads every rendition of the post, not just the primary body', () => {
    expect(
      composerProfileLinks(['hello', 'hola https://mention.earth/@alice'], NO_MENTIONS),
    ).toEqual([{ url: 'https://mention.earth/@alice', handle: 'alice' }]);
  });
});

describe('a link that will stay a link is never claimed', () => {
  it('leaves a fediverse profile alone — this side cannot know who it names', () => {
    expect(composerProfileLinks(['https://mastodon.social/@alice'], NO_MENTIONS)).toEqual([]);
  });

  it('leaves an ordinary link alone', () => {
    expect(
      composerProfileLinks(['https://mention.earth/p/abc123 and https://example.com/alice'], NO_MENTIONS),
    ).toEqual([]);
  });

  it('leaves a lookalike host alone', () => {
    expect(composerProfileLinks(['https://mention.earth.evil.test/@alice'], NO_MENTIONS)).toEqual([]);
    expect(composerProfileLinks(['https://notmention.earth/@alice'], NO_MENTIONS)).toEqual([]);
  });

  it('leaves a subpage of a profile alone — it is a different document', () => {
    expect(composerProfileLinks(['https://mention.earth/@alice/followers'], NO_MENTIONS)).toEqual([]);
  });

  it('leaves text that is not a URL alone', () => {
    expect(composerProfileLinks(['mention.earth @alice', ''], NO_MENTIONS)).toEqual([]);
  });
});

describe('a percent-encoded handle is where the two sides disagree', () => {
  /**
   * THIS TEST DOCUMENTS A DIVERGENCE, IT DOES NOT ENDORSE ONE.
   *
   * The composer decodes, because it uses `ownProfileUrlHandle` — the reader's
   * rule, which decodes so a reader sees `@café` and not `@caf%C3%A9`, and which
   * this side has to match or a URL would become a mention on screen for the
   * reader and something else here.
   *
   * The write boundary does NOT decode: its own-host branch hands
   * `localProfilePathHandle`'s VERBATIM path segment to `resolveOxyUser`, so it
   * asks Oxy for the literal `caf%C3%A9` and misses. It inherited that from the
   * federated ingest path, where nothing decoded either.
   *
   * So for this one shape the composer names somebody the post will not carry —
   * an over-claim, the wrong direction. It is pinned here rather than papered
   * over locally, because the fix belongs in the resolver: a handle the server
   * cannot look up should not be one the composer can. When that lands, this
   * case stops being a divergence and this test should assert agreement.
   */
  it('extracts the DECODED handle — which the write boundary will not resolve', () => {
    expect(composerProfileLinks(['https://mention.earth/@caf%C3%A9'], NO_MENTIONS)).toEqual([
      { url: 'https://mention.earth/@caf%C3%A9', handle: 'café' },
    ]);
  });

  it('claims nothing when the encoding does not decode to a usable handle', () => {
    // A segment that decodes to a route-hostile character, to nothing, or not at
    // all yields no candidate on either side — the shapes the two DO agree on.
    expect(composerProfileLinks(['https://mention.earth/@a%2Fb'], NO_MENTIONS)).toEqual([]);
    expect(composerProfileLinks(['https://mention.earth/@%20'], NO_MENTIONS)).toEqual([]);
    expect(composerProfileLinks(['https://mention.earth/@%E0%A4%A'], NO_MENTIONS)).toEqual([]);
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
    expect(links[0].handle).toBe('user0');
    expect(links.at(-1)?.handle).toBe(`user${MAX_PROFILE_LINKS_PER_BODY - 1}`);
  });

  it('claims nothing once the picked mentions have used the whole ceiling', () => {
    const { text, ids } = fullMentionRegistry();

    expect(composerProfileLinks([`${text} https://mention.earth/@alice`], ids)).toEqual([]);
  });

  it('takes only the headroom the picked mentions leave', () => {
    const { text, ids } = fullMentionRegistry();
    const oneFewer = ids.slice(0, MAX_MENTIONS_PER_POST - 1);
    const body = `${oneFewer.map((id) => `[mention:${id}]`).join(' ')} https://mention.earth/@alice https://mention.earth/@bob`;

    expect(composerProfileLinks([body], oneFewer)).toEqual([
      { url: 'https://mention.earth/@alice', handle: 'alice' },
    ]);
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
      { url: 'https://mention.earth/@alice', handle: 'alice' },
    ]);
  });

  it('counts each spelling of a profile separately, as the server pays for each', () => {
    const links = composerProfileLinks(
      ['https://mention.earth/@alice https://mention.earth/ap/users/alice'],
      NO_MENTIONS,
    );

    expect(links.map((link) => link.handle)).toEqual(['alice', 'alice']);
  });

  it('does not spend a slot twice on the same URL written twice', () => {
    expect(
      composerProfileLinks(
        ['https://mention.earth/@alice', 'https://mention.earth/@alice'],
        NO_MENTIONS,
      ),
    ).toHaveLength(1);
  });
});

describe('the host gate is the whole safety property', () => {
  it('is the same decision the reader’s linkifier makes', () => {
    // Not a re-implementation: both go through `ownProfileLinkHandle`, so a URL
    // that becomes a mention on screen for the reader is the same URL the
    // composer offers to name.
    expect(ownProfileLinkHandle('https://mention.earth/@alice')).toBe('alice');
    expect(ownProfileLinkHandle('https://mastodon.social/@alice')).toBeUndefined();
  });
});
