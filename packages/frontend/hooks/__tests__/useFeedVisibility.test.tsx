import TestRenderer, { act } from 'react-test-renderer';
import { useFeedVisibility } from '../useFeedVisibility';
import type { FeedImpressionTracker } from '@/utils/feedTelemetry';

let mockVisible = true;
jest.mock('@oxy.so/bloom/screen', () => ({ useScreenVisible: () => mockVisible }));

it('accrues dwell only while the screen is visible, or in a Picture-in-Picture window', () => {
  const setActive = jest.fn();
  const ref = { current: { setActive } as unknown as FeedImpressionTracker };
  function Probe() {
    useFeedVisibility(ref);
    return null;
  }
  function PipProbe() {
    useFeedVisibility(ref, true);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  expect(setActive).toHaveBeenLastCalledWith(true);
  mockVisible = false;
  act(() => renderer.update(<Probe />));
  expect(setActive).toHaveBeenLastCalledWith(false);
  act(() => renderer.update(<PipProbe />));
  expect(setActive).toHaveBeenLastCalledWith(true);
  act(() => renderer.unmount());
  expect(setActive).toHaveBeenLastCalledWith(false);
});
