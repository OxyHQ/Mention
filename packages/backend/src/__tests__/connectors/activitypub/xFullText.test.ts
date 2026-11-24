import { describe, expect, it } from 'vitest';
import {
  bridgedTweetId,
  completeCutBody,
  mayBeCutNote,
} from '../../../connectors/activitypub/xFullText';

describe('xFullText', () => {
  it('completes a cut body and keeps the quoted tweet link the full text lacks', () => {
    const cut = 'Together we are making it faster, it is going to be quite the improvement by';
    const full = `${cut} the end of the year.`;
    expect(completeCutBody(`${cut}\nhttps://x.com/chatgpt/status/1`, full)).toBe(
      `${full}\nhttps://x.com/chatgpt/status/1`,
    );
  });

  it('leaves a body alone when the full text is not longer', () => {
    expect(completeCutBody('same text', 'same text')).toBeUndefined();
  });

  it('only a bridged X status id can be a cut note, and only a long body', () => {
    expect(bridgedTweetId('https://bird.makeup/users/a/statuses/123')).toBe('123');
    expect(bridgedTweetId('https://mastodon.social/users/a/statuses/123')).toBeUndefined();
    expect(mayBeCutNote('x'.repeat(120))).toBe(false);
    expect(mayBeCutNote('x'.repeat(277))).toBe(true);
  });
});

describe('completeCutBody keeps what the bridge resolved', () => {
  it('keeps a mention placeholder in the cut prose and appends only the missing end', () => {
    const cut = 'Thanks [mention:abc123] for the long thread about shipping faster, it is going by';
    const full = 'Thanks @alice for the long thread about shipping faster, it is going by the end.';
    expect(completeCutBody(cut, full)).toBe(`${cut} the end.`);
  });

  it('declines when the end of the prose is not in the full text', () => {
    expect(
      completeCutBody('a completely different text of enough length', 'other'),
    ).toBeUndefined();
  });
});
