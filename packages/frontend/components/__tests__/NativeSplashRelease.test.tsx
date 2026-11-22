import TestRenderer, { act } from 'react-test-renderer';
import { NativeSplashRelease } from '../NativeSplashRelease';

/**
 * The splash is released by the route tree's first layout, at once (not on a later
 * JS frame, which queued behind the startup renders), and only once — a re-layout
 * or a remount never asks again.
 */

const mockHide = jest.fn();
jest.mock('@oxy.so/expo-splash', () => ({ hideNativeSplash: () => mockHide() }));

it('releases the native splash on the first layout, once', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<NativeSplashRelease />);
  });
  const marker = renderer.root.findByType('View' as never);
  expect(mockHide).not.toHaveBeenCalled();

  act(() => marker.props.onLayout());
  expect(mockHide).toHaveBeenCalledTimes(1);

  act(() => marker.props.onLayout());
  expect(mockHide).toHaveBeenCalledTimes(1);
});
