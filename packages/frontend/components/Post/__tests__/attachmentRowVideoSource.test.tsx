import { Platform } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import PostAttachmentsRow from '../PostAttachmentsRow';

/**
 * Which file a video cell plays.
 *
 * The uploaded original is whatever the author had — an Instagram reel arrives
 * as VP9, which an iPhone cannot decode, so the cell showed its poster and never
 * played. Oxy's HLS ladder is an H.264 transcode every browser decodes, so the
 * cell plays the ladder when the server has one and keeps the original as the
 * one-shot fallback — on web as on native.
 */
const captured: { type?: string; src?: string; fallbackSrc?: string }[] = [];

jest.mock('../Attachments', () => ({
  PostAttachmentMedia: (props: { type?: string; src?: string; fallbackSrc?: string }) => {
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

jest.mock('@/components/Podcast/PostPodcastAttachment', () => ({
  PostPodcastAttachment: () => null,
}));
jest.mock('@/components/Post/JobCard', () => ({ __esModule: true, default: () => null }));
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

const ORIGINAL = 'https://cloud.oxy.so/m1';
const LADDER = 'https://cloud.oxy.so/m1?variant=hls_master';

function videoCell(media: { id: string; type: 'video'; url: string; hlsUrl?: string }) {
  captured.length = 0;
  act(() => {
    TestRenderer.create(<PostAttachmentsRow postId="post-1" media={[media]} />);
  });
  return captured.find((p) => p.type === 'video');
}

describe.each(['web', 'ios', 'android'] as const)('a video cell on %s', (os) => {
  const originalOs = Platform.OS;
  beforeAll(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });
  });
  afterAll(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalOs });
  });

  it('plays the H.264 ladder and keeps the original as the fallback', () => {
    const cell = videoCell({ id: 'm1', type: 'video', url: ORIGINAL, hlsUrl: LADDER });
    expect(cell?.src).toBe(LADDER);
    expect(cell?.fallbackSrc).toBe(ORIGINAL);
  });

  it('plays the original, with nothing to fall back to, when there is no ladder yet', () => {
    const cell = videoCell({ id: 'm1', type: 'video', url: ORIGINAL });
    expect(cell?.src).toBe(ORIGINAL);
    expect(cell?.fallbackSrc).toBeUndefined();
  });
});
