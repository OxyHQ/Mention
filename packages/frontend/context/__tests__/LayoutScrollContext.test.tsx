import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  LayoutScrollProvider,
  useLayoutScroll,
} from '@/context/LayoutScrollContext';

jest.mock('react-native-reanimated', () => ({
  useSharedValue: (initial: number) => ({ value: initial }),
}));

type LayoutScrollApi = ReturnType<typeof useLayoutScroll>;

function Capture({
  onValue,
}: {
  onValue: (value: LayoutScrollApi) => void;
}) {
  onValue(useLayoutScroll());
  return null;
}

describe('LayoutScrollContext imperative scrolling', () => {
  it('scrolls the active virtualized owner to a bounded offset', () => {
    let api: LayoutScrollApi | undefined;
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    const scrollToOffset = jest.fn();

    act(() => {
      renderer = TestRenderer.create(
        <LayoutScrollProvider>
          <Capture onValue={(value) => { api = value; }} />
        </LayoutScrollProvider>,
      );
    });

    let unregister: (() => void) | undefined;
    act(() => {
      unregister = api?.registerScrollable({ scrollToOffset });
      api?.scrollToOffset(240, false);
      api?.scrollToOffset(-50);
      api?.scrollToTop();
    });

    expect(scrollToOffset).toHaveBeenNthCalledWith(
      1,
      { offset: 240, animated: false },
    );
    expect(scrollToOffset).toHaveBeenNthCalledWith(
      2,
      { offset: 0, animated: true },
    );
    expect(scrollToOffset).toHaveBeenNthCalledWith(
      3,
      { offset: 0, animated: true },
    );

    act(() => {
      unregister?.();
      renderer?.unmount();
    });
  });
});
