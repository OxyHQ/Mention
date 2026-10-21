import TestRenderer, { act } from 'react-test-renderer';
import { useFeedVisibility } from '../useFeedVisibility';
import type { FeedImpressionTracker } from '@/utils/feedTelemetry';

let mockFocused = true;
let mockScreenActive = true;
const mockAppState = { currentState: 'active', addEventListener: jest.fn() };
const mockPlatform = { OS: 'ios' };
jest.mock('react-native', () => ({
  get AppState() {
    return mockAppState;
  },
  get Platform() {
    return mockPlatform;
  },
}));
jest.mock('@/lib/navigation/router', () => ({ useIsFocused: () => mockFocused }));
jest.mock('@oxy.so/bloom/screen', () => ({
  useScreenViewport: () => ({ active: mockScreenActive }),
}));

it('pauses native background, route blur and hidden screens, restoring without scrolling', () => {
  const setActive = jest.fn();
  const ref = { current: { setActive } as unknown as FeedImpressionTracker };
  const remove = jest.fn();
  let notify = () => {};
  mockAppState.addEventListener.mockImplementation((_event, fn) => {
    notify = fn;
    return { remove };
  });
  function Probe() {
    useFeedVisibility(ref);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  expect(setActive).toHaveBeenLastCalledWith(true);
  mockAppState.currentState = 'background';
  act(() => notify());
  expect(setActive).toHaveBeenLastCalledWith(false);
  mockAppState.currentState = 'active';
  act(() => notify());
  expect(setActive).toHaveBeenLastCalledWith(true);
  mockFocused = false;
  act(() => renderer.update(<Probe />));
  expect(setActive).toHaveBeenLastCalledWith(false);
  mockFocused = true;
  mockScreenActive = false;
  act(() => renderer.update(<Probe />));
  expect(setActive).toHaveBeenLastCalledWith(false);
  mockScreenActive = true;
  act(() => renderer.update(<Probe />));
  expect(setActive).toHaveBeenLastCalledWith(true);
  act(() => renderer.unmount());
  expect(remove).toHaveBeenCalled();
});

it('pauses a hidden browser document and unsubscribes on unmount', () => {
  mockPlatform.OS = 'web';
  const listeners = new Set<() => void>();
  const documentStub = {
    visibilityState: 'visible',
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  const original = globalThis.document;
  Object.defineProperty(globalThis, 'document', { value: documentStub, configurable: true });
  const setActive = jest.fn();
  const ref = { current: { setActive } as unknown as FeedImpressionTracker };
  function Probe() {
    useFeedVisibility(ref);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  expect(setActive).toHaveBeenLastCalledWith(true);
  documentStub.visibilityState = 'hidden';
  act(() => {
    for (const listener of listeners) listener();
  });
  expect(setActive).toHaveBeenLastCalledWith(false);
  documentStub.visibilityState = 'visible';
  act(() => {
    for (const listener of listeners) listener();
  });
  expect(setActive).toHaveBeenLastCalledWith(true);
  act(() => renderer.unmount());
  expect(listeners.size).toBe(0);
  Object.defineProperty(globalThis, 'document', { value: original, configurable: true });
});
