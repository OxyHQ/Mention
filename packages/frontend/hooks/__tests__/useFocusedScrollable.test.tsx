import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockRelease = jest.fn();
const mockRegister = jest.fn((..._args: unknown[]) => mockRelease);
let mockFocused = true;

jest.mock('expo-router', () => ({ useIsFocused: () => mockFocused }));
jest.mock('@/context/LayoutScrollContext', () => ({
  useLayoutScroll: () => ({ registerScrollable: mockRegister }),
}));

// eslint-disable-next-line import/first -- the mocks above must be installed first.
import { useFocusedScrollable } from '../useFocusedScrollable';

const scroller = { scrollToOffset: jest.fn() };

function List({ enabled }: { enabled?: boolean }) {
  const ref = useFocusedScrollable<typeof scroller>({ enabled, initialOffset: 0 });
  // Stand in for React attaching the list's ref.
  React.useLayoutEffect(() => {
    ref(scroller);
    return () => ref(null);
  }, [ref]);
  return null;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFocused = true;
});

it('owns the scroll while its screen is in front', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<List />); });
  expect(mockRegister).toHaveBeenCalledWith(scroller, 0);
  expect(mockRelease).not.toHaveBeenCalled();
  act(() => renderer.unmount());
  expect(mockRelease).toHaveBeenCalled();
});

it('releases the scroll when its screen goes behind, and takes it back on return', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<List />); });
  mockRegister.mockClear();

  mockFocused = false;
  act(() => { renderer.update(<List />); });
  expect(mockRelease).toHaveBeenCalled();
  expect(mockRegister).not.toHaveBeenCalled();

  mockFocused = true;
  act(() => { renderer.update(<List />); });
  expect(mockRegister).toHaveBeenCalledWith(scroller, 0);
  act(() => renderer.unmount());
});

it('never registers a background tab', () => {
  mockFocused = false;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<List />); });
  expect(mockRegister).not.toHaveBeenCalled();
  act(() => renderer.unmount());
});

it('never registers a list that does not scroll itself', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<List enabled={false} />); });
  expect(mockRegister).not.toHaveBeenCalled();
  act(() => renderer.unmount());
});
