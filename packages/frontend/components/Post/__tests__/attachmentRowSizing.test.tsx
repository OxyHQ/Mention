import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import PostAttachmentsRow from '../PostAttachmentsRow';

/**
 * How the attachments row sizes what it holds.
 *
 * - ONE item takes the full width of the row, whatever it is.
 * - SEVERAL items share ONE height — a strip, not a skyline — so every item is
 *   handed the same row height.
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

describe('one item takes the full width', () => {
  it('a link card is as wide as an image would be, with no fixed height', () => {
    const alone = render({ documents: [link] });
    expect(of(alone, 'link').width).toBeGreaterThan(280);
    expect(of(alone, 'link').constrainedHeight).toBeUndefined();
  });

  it('a podcast card spans the row', () => {
    const alone = render({ podcast });
    expect(of(alone, 'podcast').width).toBeGreaterThan(340);
    expect(of(alone, 'podcast').height).toBeUndefined();
  });

  it('an image is the hero form', () => {
    expect(of(render({ media: [image] }), 'media').hasSingleMedia).toBe(true);
  });
});

describe('several items share one height', () => {
  it('an image, a link and a podcast are all handed the same height', () => {
    const row = render({ media: [image], documents: [link], podcast });
    const heights = [
      of(row, 'media').rowHeight,
      of(row, 'link').constrainedHeight,
      of(row, 'podcast').height,
    ];
    expect(typeof heights[0]).toBe('number');
    expect(new Set(heights).size).toBe(1);
  });

  it('a poll makes the whole row taller, not just itself', () => {
    const plain = render({ media: [image], documents: [link] });
    const withPoll = render({ media: [image], documents: [link], pollData: { question: 'Q', options: ['a', 'b'] } });
    expect(of(withPoll, 'media').rowHeight).toBeGreaterThan(of(plain, 'media').rowHeight as number);
    expect(of(withPoll, 'poll').style).toEqual({ height: of(withPoll, 'media').rowHeight });
  });

  it('an embeddable link is a static card beside other items, a player alone', () => {
    const youtube = { canonicalUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', title: 'Video' };
    expect(render({ documents: [youtube] }).some((item) => item.kind === 'embed')).toBe(true);
    const beside = render({ documents: [youtube], media: [image] });
    expect(beside.some((item) => item.kind === 'embed')).toBe(false);
    expect(of(beside, 'link').constrainedHeight).toBe(of(beside, 'media').rowHeight);
  });
});

describe('a job card follows the same rules', () => {
  it('spans the row alone, and shares the row height beside an image', () => {
    const job = { mentionJobId: 'job-1', title: 'Engineer', status: 'published' };
    expect(of(render({ job }), 'job').height).toBeUndefined();
    const beside = render({ job, media: [image] });
    expect(of(beside, 'job').height).toBe(of(beside, 'media').rowHeight);
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
