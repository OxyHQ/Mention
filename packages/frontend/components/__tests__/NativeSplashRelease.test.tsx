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
