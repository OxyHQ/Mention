import { MAX_POST_DOCUMENTS } from '@mention/shared-types/post';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import PostAttachmentsRow from '../PostAttachmentsRow';

/**
 * How the attachments row sizes what it holds.
 *
 * - ONE item takes the full width of the row, whatever it is.
 * - SEVERAL items share ONE height — a strip, not a skyline — so every item is
 *   handed the same row-height class.
 * - Every width comes from layout (classes and the media's own ratio); nothing
 *   is measured.
 * - A quoted post is not an item: it renders below the row, at full width.
 */
type Captured = { kind: string; props: Record<string, unknown> };
const captured: Captured[] = [];
const capture = (kind: string) => (props: Record<string, unknown>) => {
  captured.push({ kind, props });
  return null;
};

jest.mock('../Attachments', () => ({
  PostAttachmentMedia: capture('media'),
  PostAttachmentArticle: capture('article'),
  PostAttachmentLink: capture('link'),
  PostAttachmentExternalEmbed: capture('embed'),
  PostAttachmentPoll: capture('poll'),
  PostAttachmentNested: capture('nested'),
  PostAttachmentEvent: capture('event'),
  PostAttachmentRoom: capture('room'),
}));
jest.mock('@/components/Podcast/PostPodcastAttachment', () => ({ PostPodcastAttachment: capture('podcast') }));
jest.mock('@/components/Post/JobCard', () => ({ __esModule: true, default: capture('job') }));
jest.mock('@/lib/oxyServices', () => ({ oxyServices: {} }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@oxy.so/bloom/zoomable-image-gallery', () => ({ ZoomableMediaGallery: () => null }));
jest.mock('@oxy.so/bloom/media-flight', () => ({
  useMediaFlight: () => ({ registerAnchor: jest.fn(), measureAnchor: jest.fn(), flyTo: jest.fn() }),
}));
jest.mock('@/stores/videoPlayerRegistry', () => ({
  holdAcrossTransition: jest.fn(),
  peekVideoPlayer: () => undefined,
  videoPlayerKey: (postId: string, mediaId: string) => `${postId}:${mediaId}`,
}));
jest.mock('@/utils/imageUrlCache', () => ({
  getCachedFileDownloadUrlSync: (_s: unknown, id: string) => `https://cdn/${id}`,
  videoPosterUrl: (id: string) => `https://cdn/${id}?poster`,
}));
jest.mock('@/stores/externalEmbedsStore', () => ({
  useExternalEmbedsStore: (selector: (s: { prefs: Record<string, unknown> }) => unknown) =>
    selector({ prefs: {} }),
}));


const image = { id: 'm1', type: 'image' as const, url: 'https://cdn/m1.jpg', width: 1200, height: 800 };
const link = { canonicalUrl: 'https://example.com/a', title: 'A' };
const podcast = { syraPodcastId: 'pod-1', title: 'Show', showUrl: 'https://syra.fm/podcasts/pod-1' };

function render(props: Record<string, unknown>): Captured[] {
  captured.length = 0;
  act(() => {
    TestRenderer.create(<PostAttachmentsRow postId="post-1" {...props} />);
  });
  return [...captured];
}

const of = (items: Captured[], kind: string) => items.find((item) => item.kind === kind)?.props ?? {};

/** The height class a carousel cell was given, if any. */
const heightClass = (props: Record<string, unknown>) =>
  String(props.className ?? '').match(/\bh-\[\d+px\]/)?.[0];

describe('one item takes the full width', () => {
  it('a link card fills the row by layout, with no fixed height', () => {
    const link1 = of(render({ documents: [link] }), 'link');
    expect(link1.className).toBe('w-full');
    expect(link1.coverFill).toBe(false);
  });

  it('a podcast card spans the row', () => {
    const alone = render({ podcast });
    expect(of(alone, 'podcast').width).toBe('100%');
    expect(of(alone, 'podcast').height).toBeUndefined();
  });

  it('an image is the hero form', () => {
    expect(of(render({ media: [image] }), 'media').hasSingleMedia).toBe(true);
  });

  it('nothing is sized from a measured width', () => {
    const alone = render({ media: [image] });
    expect(of(alone, 'media')).not.toHaveProperty('availableWidth');
  });
});

describe('several items share one height', () => {
  it('an image, a link and a podcast take the same row height', () => {
    const row = render({ media: [image], documents: [link], podcast });
    expect(of(row, 'media').tallRow).toBe(false);
    expect(heightClass(of(row, 'link'))).toBe('h-[200px]');
    expect(of(row, 'podcast').height).toBe(200);
  });

  it('a poll makes the whole row taller, not just itself', () => {
    const withPoll = render({ media: [image], documents: [link], pollData: { question: 'Q', options: ['a', 'b'] } });
    expect(of(withPoll, 'media').tallRow).toBe(true);
    expect(heightClass(of(withPoll, 'poll'))).toBe('h-[264px]');
    expect(heightClass(of(withPoll, 'link'))).toBe('h-[264px]');
  });

  it('an embeddable link is a static card beside other items, a player alone', () => {
    const youtube = { canonicalUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', title: 'Video' };
    expect(render({ documents: [youtube] }).some((item) => item.kind === 'embed')).toBe(true);
    const beside = render({ documents: [youtube], media: [image] });
    expect(beside.some((item) => item.kind === 'embed')).toBe(false);
    expect(of(beside, 'link').coverFill).toBe(true);
    expect(heightClass(of(beside, 'link'))).toBe('h-[200px]');
  });
});

describe('a job card follows the same rules', () => {
  it('spans the row alone, and shares the row height beside an image', () => {
    const job = { mentionJobId: 'job-1', title: 'Engineer', status: 'published' };
    expect(of(render({ job }), 'job').className).toBe('w-full');
    expect(heightClass(of(render({ job, media: [image] }), 'job'))).toBe('h-[200px]');
  });
});

describe('a quoted post renders below the row', () => {
  it('renders on its own, with nothing else attached', () => {
    const quoteOnly = render({ nestedPost: { id: 'q1' }, nestingDepth: 0 });
    expect(of(quoteOnly, 'nested').nestedPost).toEqual({ id: 'q1' });
  });

  it('leaves the image alone in the row', () => {
    const withQuote = render({ media: [image], nestedPost: { id: 'q1' }, nestingDepth: 0 });
    expect(of(withQuote, 'media').hasSingleMedia).toBe(true);
    expect(withQuote.some((item) => item.kind === 'nested')).toBe(true);
  });
});


describe('source link cards before and after metadata arrives', () => {
  it('shows real source URLs without invented article metadata, even after failed indexing', () => {
    const cards = render({ text: 'Read https://www.forbes.com/story', documents: [] }).filter((item) => item.kind === 'link');
    expect(cards).toHaveLength(1);
    expect(cards[0].props.url).toBe('https://www.forbes.com/story');
    expect(cards[0].props.title).toBeUndefined();
    expect(cards[0].props.image).toBeUndefined();
    expect(cards[0].props.description).toBeUndefined();
  });

  it('preserves source order and matches requested and canonical URLs without duplicating cards', () => {
    const cards = render({
      text: 'https://example.org/first https://kpbs.org/story https://npr.org/story https://example.org/first',
      documents: [{ canonicalUrl: 'https://npr.org/story', requestedUrl: 'https://kpbs.org/story', title: 'Real NPR article' }],
    }).filter((item) => item.kind === 'link');
    expect(cards.map((item) => item.props.url)).toEqual(['https://example.org/first', 'https://npr.org/story']);
    expect(cards[1].props.title).toBe('Real NPR article');
  });

  it('normalizes harmless URL spelling without removing query parameters', () => {
    const cards = render({ text: 'https://example.org#section https://example.org/?q=different', documents: [{ canonicalUrl: 'https://example.org/', title: 'Home' }] })
      .filter((item) => item.kind === 'link');
    expect(cards.map((item) => item.props.url)).toEqual(['https://example.org/', 'https://example.org/?q=different']);
  });

  it('excludes own profiles and labelled mentions and caps before filtering', () => {
    const text = 'https://mention.earth/@nate [@@leadership-forbes](https://flipboard.com/@forbes/leadership-bs0je34pz) '
      + Array.from({ length: MAX_POST_DOCUMENTS + 1 }, (_, index) => `https://example.org/${index}`).join(' ');
    const cards = render({ text }).filter((item) => item.kind === 'link');
    expect(cards.map((item) => item.props.url)).toEqual(Array.from({ length: MAX_POST_DOCUMENTS - 1 }, (_, index) => `https://example.org/${index}`));
  });

  it('enriches a URL card in place and updates metadata at the same URL', () => {
    const text = 'https://example.org/story';
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    const update = (documents: Array<Record<string, unknown>>) => {
      captured.length = 0;
      const props: Record<string, unknown> = { text, documents };
      act(() => {
        if (renderer) renderer.update(<PostAttachmentsRow postId="post-enrichment" {...props} />);
        else renderer = TestRenderer.create(<PostAttachmentsRow postId="post-enrichment" {...props} />);
      });
      return captured.filter((item) => item.kind === 'link');
    };
    expect(update([])).toHaveLength(1);
    const ready = update([{ canonicalUrl: text, title: 'Real article title', imageUrl: 'https://example.org/cover.jpg' }]);
    expect(ready).toHaveLength(1);
    expect(ready[0].props.title).toBe('Real article title');
    expect(ready[0].props.image).toBe('https://example.org/cover.jpg');
    const refreshed = update([{ canonicalUrl: text, title: 'Updated article title' }]);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].props.title).toBe('Updated article title');
    act(() => renderer?.unmount());
  });
});
