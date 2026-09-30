import { SINGLE_MEDIA_MAX_HEIGHT } from '@/utils/composeUtils';
import { mediaBoxStyle } from '../PostAttachmentMedia';

/**
 * A media cell alone in the attachments row spans the row (`w-full`), but its
 * height is capped (`max-h-[420px]`): past the cap it keeps its ratio by
 * narrowing, never by cropping, so a tall photo cannot take over the viewport.
 * The only inline values are the media's own ratio and the width cap it implies;
 * layout does the rest, so these tests read the style, not a measured box.
 */
jest.mock('@/components/common/VideoPlayer', () => ({ __esModule: true, default: () => null }));
jest.mock('@oxy.so/bloom/media-inset-border', () => ({ MediaInsetBorder: () => null }));
jest.mock('@oxy.so/bloom/media-flight', () => ({
  useMediaFlight: () => ({ registerAnchor: jest.fn(), measureAnchor: jest.fn(), flyTo: jest.fn() }),
}));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: {} }) }));
jest.mock('@oxy.so/bloom/icons', () => ({ RiEyeOffLine: () => null }));
jest.mock('@oxy.so/bloom/image-aspect-ratio-cache', () => ({
  getAspectRatio: () => undefined,
  hasAspectRatio: () => false,
  setAspectRatio: jest.fn(),
  DEFAULT_ASPECT_RATIO: 1,
}));
jest.mock('@/stores/videoPlayerRegistry', () => ({
  useVideoPlayerLease: () => undefined,
  videoPlayerKey: (postId: string, mediaId: string) => `${postId}:${mediaId}`,
}));

it('alone, the ratio is the only thing layout needs from the record', () => {
  expect(mediaBoxStyle(true, 3 / 2).aspectRatio).toBe(3 / 2);
});

it.each([
  ['a landscape', 16 / 9],
  ['a square', 1],
  ['a 4:5 portrait', 4 / 5],
  ['a 9:16 story', 9 / 16],
])('%s narrows at exactly the width that makes it the height cap', (_label, ratio) => {
  const { maxWidth } = mediaBoxStyle(true, ratio);
  expect((maxWidth as number) / ratio).toBeCloseTo(SINGLE_MEDIA_MAX_HEIGHT);
});

it('an extremely tall item keeps a tappable width', () => {
  expect(mediaBoxStyle(true, 1 / 20).maxWidth).toBeGreaterThanOrEqual(100);
});

it('beside other items, width comes from the row height and the ratio alone', () => {
  expect(mediaBoxStyle(false, 3 / 2)).toEqual({ aspectRatio: 3 / 2 });
});
