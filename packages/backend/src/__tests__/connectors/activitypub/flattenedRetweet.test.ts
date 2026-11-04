import { describe, it, expect } from 'bun:test';
/**
 * A retweet a reviewed bridge flattened into an ordinary post is dropped, and
 * the decision is made on the BRIDGE'S OWN TEXT: a mention anchor counts as the
 * `@handle` it shows. A false match destroys a real post, so the marker stays
 * anchored at position 0 and only reviewed bridge actors are tested.
 */

import {
  isBridgeFlattenedRetweet,
  isStoredBridgeFlattenedRetweet,
} from '../../../connectors/activitypub/flattenedRetweet';
import { REVIEWED_REPOST_TRANSPORT_HOSTS } from '../../../connectors/activitypub/repostTransportPolicy';

const BRIDGE_ACTOR = `https://${REVIEWED_REPOST_TRANSPORT_HOSTS[0]}/users/someone`;
const ORDINARY_ACTOR = 'https://ordinary-instance.test/users/someone';

const note = (content: string) => ({ type: 'Note', content });

describe('isBridgeFlattenedRetweet', () => {
  it.each([
    ['a bare handle', '<p>RT: @original the text of the tweet</p>'],
    [
      'an h-card mention anchor',
      '<p>RT: <span class="h-card"><a href="https://bridge.test/@original" class="u-url mention">@<span>original</span></a></span> the text</p>',
    ],
  ])('matches %s from a reviewed bridge', (_case, content) => {
    expect(isBridgeFlattenedRetweet(note(content), BRIDGE_ACTOR)).toBe(true);
  });

  it.each([
    ['the same body from an ordinary instance', '<p>RT: @original the text</p>', ORDINARY_ACTOR],
    ['RT not at the start', '<p>Interesante: RT: @alguien</p>', BRIDGE_ACTOR],
    ['RT without a handle after it', '<p>RT: esto es una cita</p>', BRIDGE_ACTOR],
  ])('does NOT match %s', (_case, content, actor) => {
    expect(isBridgeFlattenedRetweet(note(content), actor)).toBe(false);
  });
});

describe('isStoredBridgeFlattenedRetweet', () => {
  it('reads a stored mention back as the `@` the bridge wrote', () => {
    expect(isStoredBridgeFlattenedRetweet('RT: [mention:abc123] text', BRIDGE_ACTOR)).toBe(true);
    expect(
      isStoredBridgeFlattenedRetweet('RT: [@@a@x.com](https://x.com/a) text', BRIDGE_ACTOR),
    ).toBe(true);
    expect(isStoredBridgeFlattenedRetweet('RT: [mention:abc123] text', ORDINARY_ACTOR)).toBe(false);
    expect(isStoredBridgeFlattenedRetweet('RT: https://example.com/a', BRIDGE_ACTOR)).toBe(false);
  });
});
