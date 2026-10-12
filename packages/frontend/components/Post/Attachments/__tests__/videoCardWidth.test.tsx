import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import PostAttachmentMedia from '../PostAttachmentMedia';

interface CapturedVideoProps {
  style?: ViewStyle;
}
jest.mock('@/components/common/VideoPlayer', () => {
  const { View: RNView } = jest.requireActual('react-native');
  const React2 = jest.requireActual('react');
  return {
    __esModule: true,
    default: (props: CapturedVideoProps) =>
      React2.createElement(RNView, { testID: 'video-surface', style: props.style }),
  };
});

jest.mock('@oxy.so/bloom/image-aspect-ratio-cache', () => ({
  getAspectRatio: () => undefined,
  hasAspectRatio: () => false,
  setAspectRatio: jest.fn(),
  DEFAULT_ASPECT_RATIO: 1,
}));

jest.mock('@oxy.so/bloom/icons', () => ({ RiEyeOffLine: () => null }));

jest.mock('@oxy.so/bloom/media-inset-border', () => ({
  MediaInsetBorder: () => null,
}));

jest.mock('@oxy.so/bloom/media-flight', () => ({
  useMediaFlight: () => ({ registerAnchor: jest.fn(), measureAnchor: jest.fn(), flyTo: jest.fn() }),
}));

jest.mock('@/stores/videoPlayerRegistry', () => ({
  useVideoPlayerLease: () => undefined,
  videoPlayerKey: (postId: string, mediaId: string) => `${postId}:${mediaId}`,
}));

jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { backgroundSecondary: '#eee' } }),
}));

/** Both kinds render a native video surface, and both used to lose their width. */
const CELL_KINDS = ['video', 'gif'] as const;

function renderCell(type: (typeof CELL_KINDS)[number], props: Record<string, unknown>) {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <PostAttachmentMedia
        type={type}
        src="https://cloud.oxy.so/vid"
        postId="post-1"
        mediaId="media-1"
        {...props}
      />,
    );
  });
  return renderer!;
}

/** The card view is the parent of the mocked video surface. */
function cardOf(renderer: TestRenderer.ReactTestRenderer): { className: string; style: ViewStyle } {
  const surface = renderer.root.findByProps({ testID: 'video-surface' });
  let node = surface.parent;
  while (node && node.type !== View) node = node.parent;
  return {
    className: String(node!.props.className ?? ''),
    style: StyleSheet.flatten(node!.props.style) ?? {},
  };
}

/**
 * A native `VideoView` has no intrinsic size, so the card must resolve BOTH
 * sides by layout: one side from a class (`w-full` alone, the row height beside
 * others) and the other from the ratio.
 */
function expectDefiniteBox({ className, style }: { className: string; style: ViewStyle }) {
  expect(className).toMatch(/\bw-full\b|\bh-\[\d+px\]/);
  expect(style.aspectRatio as number).toBeGreaterThan(0);
}

describe.each(CELL_KINDS)('a %s card always has a width', (type) => {
  it.each([
    ['alone in the row', { hasSingleMedia: true }],
    // The other branch is one value, not the absence of one: it is what a cell
    // beside ANY companion gets, and it is where the width used to be missing.
    ['beside anything else', { hasSingleMedia: false }],
  ])('%s', (_label, flags) => {
    expectDefiniteBox(cardOf(renderCell(type, { ...flags, aspectRatio: 0.5625 })));
  });

  it('still has a width when the record carries no aspect ratio', () => {
    expectDefiniteBox(cardOf(renderCell(type, { hasSingleMedia: false })));
  });
});

/**
 * Production, 2026-09-27: an Instagram Reel read before its dimensions were
 * collected (media `{ type: 'video', url }`, no width/height/aspectRatio)
 * rendered as an EMPTY post on the web — the card left its height to the
 * <video>, which fills 100% of a height-less card, so the card was 0px tall.
 */
describe.each(['ios', 'web'] as const)('a lone video with NO stored dimensions (%s)', (os) => {
  const { Platform } = jest.requireActual('react-native');
  const original = Platform.OS;
  beforeEach(() => {
    Platform.OS = os;
  });
  afterEach(() => {
    Platform.OS = original;
  });

  it('gets a definite, non-zero box — never a height-less one', () => {
    const card = cardOf(renderCell('video', { hasSingleMedia: true }));
    expect(card.className).toMatch(/\bw-full\b/);
    expect(card.style.aspectRatio as number).toBeGreaterThan(0);
  });
});
