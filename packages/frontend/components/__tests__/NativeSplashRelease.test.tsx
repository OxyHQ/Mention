// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import TestRenderer, { act } from 'react-test-renderer';
import { NativeSplashRelease } from '../NativeSplashRelease';

/**
 * The splash is released by the route tree's first layout, one frame later, and
 * only once — a re-layout or a remount never asks again.
 */

const mockHide = jest.fn();
jest.mock('@oxy.so/expo-splash', () => ({ hideNativeSplash: () => mockHide() }));

it('releases the native splash on the frame after the first layout, once', () => {
  const frames: FrameRequestCallback[] = [];
  const runFrames = () => {
    for (const frame of frames.splice(0)) frame(0);
  };
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<NativeSplashRelease />);
  });
  const marker = renderer.root.findByType('View' as never);
  expect(mockHide).not.toHaveBeenCalled();

  act(() => marker.props.onLayout());
  expect(mockHide).not.toHaveBeenCalled();
  runFrames();
  expect(mockHide).toHaveBeenCalledTimes(1);

  act(() => marker.props.onLayout());
  runFrames();
  expect(mockHide).toHaveBeenCalledTimes(1);
});
