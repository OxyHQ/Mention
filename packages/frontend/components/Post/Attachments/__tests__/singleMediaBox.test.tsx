import { SINGLE_MEDIA_MAX_HEIGHT } from '@/utils/composeUtils';
import { singleMediaBox } from '../PostAttachmentMedia';

/**
 * A media cell alone in the attachments row spans the row, but its height is
 * capped: past the cap it keeps its ratio by narrowing, never by cropping, so a
 * tall photo cannot take over the whole viewport.
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


const ROW = 516;

it('a landscape image spans the row at its own ratio', () => {
  expect(singleMediaBox(3 / 2, ROW)).toEqual({ width: ROW, height: ROW / (3 / 2) });
});

it.each([
  ['a square', 1],
  ['a 4:5 portrait', 4 / 5],
  ['a 9:16 story', 9 / 16],
])('%s is capped in height and narrows to keep its ratio', (_label, ratio) => {
  const box = singleMediaBox(ratio, ROW);
  expect(box.height).toBe(SINGLE_MEDIA_MAX_HEIGHT);
  expect(box.width).toBeLessThan(ROW);
  expect(box.width / box.height).toBeCloseTo(ratio);
});

it('an extremely tall item keeps a tappable width', () => {
  expect(singleMediaBox(1 / 20, ROW).width).toBeGreaterThanOrEqual(100);
});

it('never exceeds the cap however narrow the row is', () => {
  for (const ratio of [16 / 9, 1, 9 / 16]) {
    const box = singleMediaBox(ratio, 320);
    expect(box.height).toBeLessThanOrEqual(SINGLE_MEDIA_MAX_HEIGHT);
    expect(box.width).toBeLessThanOrEqual(320);
  }
});
