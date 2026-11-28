import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ZoomableMediaGalleryHandle } from '@oxy.so/bloom/zoomable-media-gallery';

const mockOpen = jest.fn();
const mockMount = jest.fn();

// The resting avatar has its own behavior tests. Isolate this test around the
// gallery's first open when the component is combined with main's avatar UI.
jest.mock('@/components/ui/AccountAvatar', () => ({ AccountAvatar: () => null }), {
  virtual: true,
});
jest.mock(
  '@/components/ui/use-account-avatar-motion',
  () => ({ hasAccountAvatarCharacter: () => false }),
  { virtual: true },
);

jest.mock('@oxy.so/bloom/zoomable-media-gallery', () => {
  const { forwardRef, useImperativeHandle, useEffect } = require('react');
  return {
    ZoomableMediaGallery: forwardRef(function MockZoomableMediaGallery(
      _props: object,
      ref: React.Ref<ZoomableMediaGalleryHandle>,
    ) {
      useEffect(() => mockMount(), []);
      useImperativeHandle(ref, () => ({ open: (...args: unknown[]) => mockOpen(...args) }), []);
      return null;
    }),
  };
});
jest.mock('@oxy.so/bloom/image-resolver', () => ({ useImageResolver: () => undefined }));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  Extrapolation: { CLAMP: 'clamp' },
  interpolate: (value: number) => value,
  useAnimatedStyle: (callback: () => object) => callback(),
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ oxyServices: {} }),
  useFileDownloadUrl: () => ({ url: undefined }),
}));

import { ZoomableAvatar } from '../ZoomableAvatar';

it('opens the measured avatar on the first press without mounting a viewer beforehand', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const rect = { x: 12, y: 23, width: 72, height: 72 };
  const rendered: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    rendered.current = TestRenderer.create(
      <ZoomableAvatar source="https://example.test/avatar.jpg" />,
      {
        createNodeMock: () => ({
          measureInWindow: (
            callback: (x: number, y: number, width: number, height: number) => void,
          ) => callback(rect.x, rect.y, rect.width, rect.height),
        }),
      },
    );
  });
  const renderer = rendered.current;
  if (!renderer) throw new Error('Avatar did not render');
  expect(mockMount).not.toHaveBeenCalled();

  const avatar = renderer.root.findAll(
    (node) => node.props.accessibilityLabel === 'Profile avatar' && node.props.onPress,
  )[0];
  for (const node of renderer.root.findAll((item) => item.props.collapsable === false)) {
    if (node.instance && typeof node.instance.measureInWindow === 'function') {
      node.instance.measureInWindow = (
        callback: (x: number, y: number, width: number, height: number) => void,
      ) => callback(rect.x, rect.y, rect.width, rect.height);
    }
  }
  await act(async () => {
    avatar.props.onPress();
    await Promise.resolve();
  });
  expect(mockMount).toHaveBeenCalledTimes(1);
  expect(mockOpen).toHaveBeenCalledWith(
    [
      {
        uri: 'https://example.test/avatar.jpg',
        previewUri: 'https://example.test/avatar.jpg',
        aspectRatio: 1,
        shareUrl: null,
      },
    ],
    0,
    rect,
  );

  await act(async () => {
    avatar.props.onPress();
    await Promise.resolve();
  });
  expect(mockMount).toHaveBeenCalledTimes(1);
  expect(mockOpen).toHaveBeenCalledTimes(2);
  act(() => renderer.unmount());
});
