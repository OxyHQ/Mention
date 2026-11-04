import { describe, expect, it } from 'vitest';
import type { TransportCopyFacts } from '../../db/schema/postContent';
import { mergeTransportCopies, type TransportCopy } from '../../connectors/shared/transportCopies';
import { upstreamPostKey } from '../../connectors/shared/upstreamPostKey';
import { otherTransportsIn } from '../../connectors/transportFollows';

function copy(objectUri: string, facts: Partial<TransportCopyFacts>): TransportCopy {
  return {
    objectUri,
    actorUri: objectUri.split('/post')[0],
    facts: { rank: 1, text: '', media: [], sensitive: false, ...facts },
  };
}

describe('the upstream post key', () => {
  it('is the network post id each transport names, and nothing for a keyless one', () => {
    expect(upstreamPostKey('https://bird.makeup/users/someone/statuses/123')).toBe('x:123');
    expect(upstreamPostKey('https://kilogram.makeup/users/someone/statuses/AbC_12345')).toBe(
      'instagram:AbC_12345',
    );
    const atUri = 'at://did:plc:abc/app.bsky.feed.post/xyz';
    expect(upstreamPostKey(atUri)).toBe(`bluesky:${atUri}`);
    expect(upstreamPostKey(`https://bsky.brid.gy/convert/ap/${atUri}`)).toBe(`bluesky:${atUri}`);
    expect(upstreamPostKey('https://mastox.eu/users/someone/statuses/123')).toBeUndefined();
    expect(
      upstreamPostKey('https://bird.makeup/users/someone/statuses/123/activity'),
    ).toBeUndefined();
  });
});

describe('the transports of an account', () => {
  it('are the other sources Oxy lists under the same canonical account', () => {
    const identity = {
      externalIdentities: [
        { actorUri: 'https://a.example/u', canonicalAcct: 'someone@x.com' },
        { actorUri: 'https://b.example/u', canonicalAcct: 'someone@x.com' },
        { actorUri: 'https://c.example/u', canonicalAcct: 'someone@other.example' },
      ],
    };
    expect(otherTransportsIn(identity, 'https://a.example/u')).toEqual(['https://b.example/u']);
    expect(otherTransportsIn(identity, 'https://unknown.example/u')).toEqual([]);
  });
});

describe('mergeTransportCopies', () => {
  const native = copy('did:plc:abc/post', {
    rank: 0,
    publishedAt: '2026-01-01T00:00:00.000Z',
    text: 'A sentence cut sho…',
    media: [{ type: 'image' }, { type: 'image', alt: 'second' }],
  });
  const bridge = copy('https://bridge.example/post', {
    publishedAt: '2026-01-01T00:00:05.000Z',
    url: 'https://network.example/p/1',
    text: 'A sentence cut short by the other transport.',
    media: [{ type: 'image', alt: 'first' }, { type: 'image' }],
    language: 'en',
    sensitive: true,
  });

  it('fills what is missing, lets rank decide disagreements, and never depends on arrival order', () => {
    const merged = mergeTransportCopies([native, bridge]);
    expect(mergeTransportCopies([bridge, native])).toEqual(merged);
    expect(merged).toMatchObject({
      // Higher-ranked copy wins a disagreement; a missing field is filled.
      publishedAt: '2026-01-01T00:00:00.000Z',
      url: 'https://network.example/p/1',
      language: 'en',
      sensitive: true,
      // The truncated text loses to the full one whatever its rank.
      textFrom: bridge.objectUri,
      // One set of media, its missing alt filled from the copy of the same shape.
      mediaFrom: bridge.objectUri,
      mediaAlts: ['first', 'second'],
    });
  });

  it('fills no alt text from a copy whose media do not match item for item', () => {
    const other = copy('https://other.example/post', {
      media: [{ type: 'video', alt: 'not the same item' }],
    });
    const own = copy('https://x.example/post', { rank: 0, media: [{ type: 'image' }] });
    const merged = mergeTransportCopies([own, other]);
    expect(merged.mediaAlts).toEqual([undefined]);
  });
});
