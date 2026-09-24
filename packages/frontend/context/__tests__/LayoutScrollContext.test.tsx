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

describe('LayoutScrollContext scroll ownership', () => {
  function mount() {
    let api!: LayoutScrollApi;
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <LayoutScrollProvider>
          <Capture onValue={(value) => { api = value; }} />
        </LayoutScrollProvider>,
      );
    });
    return { api: () => api, renderer };
  }

  it('has no offset to report while nothing owns the scroll', () => {
    const { api, renderer } = mount();
    expect(api().getScrollOffset()).toBeNull();
    let release: (() => void) | undefined;
    act(() => { release = api().registerScrollable({ scrollToOffset: jest.fn() }, 0); });
    expect(api().getScrollOffset()).toBe(0);
    act(() => { release?.(); });
    expect(api().getScrollOffset()).toBeNull();
    act(() => renderer.unmount());
  });

  it('hands each scroller back the offset it left, not the last one to scroll', () => {
    const { api, renderer } = mount();
    const home = { scrollToOffset: jest.fn() };
    const notifications = { scrollToOffset: jest.fn() };

    let releaseHome: (() => void) | undefined;
    act(() => { releaseHome = api().registerScrollable(home, 0); });
    act(() => { api().setScrollY(900); });

    // Home goes behind; notifications comes forward at its own top.
    let releaseNotifications: (() => void) | undefined;
    act(() => {
      releaseHome?.();
      releaseNotifications = api().registerScrollable(notifications, 0);
    });
    expect(api().getScrollOffset()).toBe(0);

    // And back: home is where the reader left it.
    act(() => {
      releaseNotifications?.();
      releaseHome = api().registerScrollable(home, 0);
    });
    expect(api().getScrollOffset()).toBe(900);

    act(() => {
      releaseHome?.();
      renderer.unmount();
    });
  });

  it('leaves the offset alone for a scroller that does not know where it starts', () => {
    const { api, renderer } = mount();
    act(() => { api().setScrollY(300); });
    act(() => { api().registerScrollable({ scrollTo: jest.fn() }); });
    expect(api().getScrollOffset()).toBe(300);
    act(() => renderer.unmount());
  });
});
