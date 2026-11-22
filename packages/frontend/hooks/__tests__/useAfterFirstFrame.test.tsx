import TestRenderer, { act } from 'react-test-renderer';
import { useAfterFirstFrame } from '../useAfterFirstFrame';

it('is false for the first render and true from the next frame', () => {
  jest.useFakeTimers();
  const seen: boolean[] = [];
  function Probe() {
    seen.push(useAfterFirstFrame());
    return null;
  }
  act(() => {
    TestRenderer.create(<Probe />);
  });
  expect(seen).toEqual([false]);
  act(() => {
    jest.runOnlyPendingTimers();
  });
  expect(seen.at(-1)).toBe(true);
  jest.useRealTimers();
});
