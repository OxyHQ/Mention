import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import PostAttachmentMedia from '../PostAttachmentMedia';

interface CapturedVideoProps { style?: ViewStyle }
jest.mock('@/components/common/VideoPlayer', () => {
  const { View: RNView } = jest.requireActual('react-native');
  const React2 = jest.requireActual('react');
  return {
    __esModule: true,
    default: (props: CapturedVideoProps) =>
      React2.createElement(RNView, { testID: 'video-surface', style: props.style }),
  };
});

jest.mock('@oxyhq/bloom/image-aspect-ratio-cache', () => ({
  getAspectRatio: () => undefined,
  hasAspectRatio: () => false,
  setAspectRatio: jest.fn(),
  DEFAULT_ASPECT_RATIO: 1,
}));

jest.mock('@oxyhq/bloom/media-inset-border', () => ({
  MediaInsetBorder: () => null,
}));

jest.mock('@oxyhq/bloom/media-flight', () => ({
  useMediaFlight: () => ({ registerAnchor: jest.fn(), measureAnchor: jest.fn(), flyTo: jest.fn() }),
}));

jest.mock('@/stores/videoPlayerRegistry', () => ({
  useVideoPlayerLease: () => undefined,
  videoPlayerKey: (postId: string, mediaId: string) => `${postId}:${mediaId}`,
}));

jest.mock('@oxyhq/bloom/theme', () => ({
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
        availableWidth={390}
        {...props}
      />,
    );
  });
  return renderer!;
}

/** The card view is the parent of the mocked video surface. */
function cardStyleOf(renderer: TestRenderer.ReactTestRenderer): ViewStyle {
  const surface = renderer.root.findByProps({ testID: 'video-surface' });
  let node = surface.parent;
  while (node && node.type !== View) node = node.parent;
  return StyleSheet.flatten(node!.props.style) ?? {};
}

describe.each(CELL_KINDS)('a %s card always has a width', (type) => {
  it.each([
    ['alone in the row', { hasSingleMedia: true }],
    // The other branch is one value, not the absence of one: it is what a cell
    // beside ANY companion gets, and it is where the width used to be missing.
    ['beside anything else', { hasSingleMedia: false }],
  ])('%s', (_label, flags) => {
    const style = cardStyleOf(renderCell(type, { ...flags, aspectRatio: 0.5625 }));
    expect(typeof style.width).toBe('number');
    expect(style.width as number).toBeGreaterThan(0);
  });

  it('still has a width when the record carries no aspect ratio', () => {
    const style = cardStyleOf(renderCell(type, { hasSingleMedia: false }));
    expect(typeof style.width).toBe('number');
    expect(style.width as number).toBeGreaterThan(0);
  });
});
