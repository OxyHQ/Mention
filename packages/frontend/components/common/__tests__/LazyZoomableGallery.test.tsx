import React, { createRef } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ZoomableMediaGalleryHandle } from '@oxy.so/bloom/zoomable-media-gallery';

import { LazyZoomableGallery } from '../LazyZoomableGallery';

/**
 * The zoom viewer must cost a feed row nothing until it is opened (#1103), and
 * the first tap must still open it — at the image and rect that were tapped.
 */

const mockOpen = jest.fn();
const mockMounts = jest.fn();

jest.mock('@oxy.so/bloom/zoomable-media-gallery', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { forwardRef: fwd, useImperativeHandle: useHandle, useEffect } = require('react');
  return {
    ZoomableMediaGallery: fwd((_props: object, ref: React.Ref<ZoomableMediaGalleryHandle>) => {
      useEffect(() => mockMounts(), []);
      useHandle(ref, () => ({ open: (...args: unknown[]) => mockOpen(...args) }), []);
      return null;
    }),
  };
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => jest.clearAllMocks());

it('mounts nothing until opened, then replays the first open with its arguments', () => {
  const ref = createRef<ZoomableMediaGalleryHandle>();
  act(() => {
    TestRenderer.create(<LazyZoomableGallery ref={ref} cornerRadius={8} />);
  });
  expect(mockMounts).not.toHaveBeenCalled();

  const images = [{ uri: 'a.jpg' }, { uri: 'b.jpg' }];
  const rect = { x: 1, y: 2, width: 3, height: 4 };
  act(() => ref.current?.open(images as never, 1, rect));

  expect(mockMounts).toHaveBeenCalledTimes(1);
  expect(mockOpen).toHaveBeenCalledTimes(1);
  expect(mockOpen).toHaveBeenCalledWith(images, 1, rect);

  // Later opens go straight through, with no remount.
  act(() => ref.current?.open(images as never, 0));
  expect(mockMounts).toHaveBeenCalledTimes(1);
  expect(mockOpen).toHaveBeenCalledTimes(2);
  expect(mockOpen).toHaveBeenLastCalledWith(images, 0);
});
