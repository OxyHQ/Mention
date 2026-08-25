import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import PostAttachmentsRow from '../PostAttachmentsRow';

/**
 * Which FORM a media cell takes in the attachments row.
 *
 * The row used to answer this from a hand-maintained list of item types that
 * disqualify the hero form (`poll`, `article`, `nested`, `link`). Three types
 * the row already renders were missing from it — `event`, `room`, `podcast` —
 * and any type added later would have been missing too. Paired with a card that
 * only received a width in the hero branch, that is what left a video beside a
 * link preview at ZERO WIDTH on native.
 *
 * So the property under test is deliberately stated over EVERY companion the row
 * can render, not over the four that were listed: a media cell is the hero only
 * when it is alone.
 */
const captured: { hasSingleMedia?: boolean; type?: string }[] = [];

jest.mock('../Attachments', () => ({
  PostAttachmentMedia: (props: { hasSingleMedia?: boolean; type?: string }) => {
    captured.push(props);
    return null;
  },
  PostAttachmentArticle: () => null,
  PostAttachmentLink: () => null,
  PostAttachmentExternalEmbed: () => null,
  PostAttachmentPoll: () => null,
  PostAttachmentNested: () => null,
  PostAttachmentEvent: () => null,
  PostAttachmentRoom: () => null,
}));

jest.mock('@/components/Podcast/PodcastCard', () => ({ PodcastCard: () => null }));
jest.mock('@oxyhq/services/ui/client', () => ({ useAuth: () => ({ oxyServices: {} }) }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@oxyhq/bloom/zoomable-image-gallery', () => ({ ZoomableMediaGallery: () => null }));
jest.mock('@oxyhq/bloom/media-flight', () => ({
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

const video = [{ id: 'm1', type: 'video' as const, url: 'https://cdn/m1.mp4' }];

function formOfVideo(props: Record<string, unknown>): boolean | undefined {
  captured.length = 0;
  act(() => {
    TestRenderer.create(<PostAttachmentsRow postId="post-1" media={video} {...props} />);
  });
  return captured.find((p) => p.type === 'video')?.hasSingleMedia;
}

describe('a media cell is the hero form only when it is alone in the row', () => {
  it('is the hero when the video is the only attachment', () => {
    expect(formOfVideo({})).toBe(true);
  });

  it.each([
    // The four the old list happened to name.
    ['a link preview', { linkPreviews: [{ url: 'https://example.com' }] }],
    ['a poll', { pollId: 'poll-1' }],
    ['an article', { article: { title: 'Title' } }],
    ['a quoted post', { nestedPost: { id: 'q1' }, nestingDepth: 0 }],
    // The three it did NOT, which is the point: these failed before the fix.
    ['an event', { event: { name: 'Launch' } }],
    ['a room', { room: { roomId: 'room-1' } }],
    ['a podcast', { podcast: { syraPodcastId: 'pod-1' } }],
    // And a second media item.
    ['another image', { media: [...video, { id: 'm2', type: 'image', url: 'https://cdn/m2.jpg' }] }],
  ])('yields the row form beside %s', (_label, props) => {
    expect(formOfVideo(props)).toBe(false);
  });
});
