import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockScrollToTop = jest.fn();
let mockOffset: number | null = 0;
let mockFocused = true;

jest.mock('@/context/LayoutScrollContext', () => ({
  useLayoutScroll: () => ({
    getScrollOffset: () => mockOffset,
    scrollToTop: mockScrollToTop,
  }),
}));
jest.mock('expo-router', () => ({ useIsFocused: () => mockFocused }));

// eslint-disable-next-line import/first -- the mocks above must be installed first.
import {
  AT_TOP_THRESHOLD,
  ScreenReselectProvider,
  isOffsetAtTop,
  useReselect,
  useReselectReloadKey,
  useScreenReselect,
  useTabSelect,
  type ReselectHandler,
} from '../ScreenReselectContext';

let reselect!: () => void;
function Trigger() {
  reselect = useReselect();
  return null;
}
function Screen({ handler }: { handler: ReselectHandler }) {
  useScreenReselect(handler);
  return null;
}

function render(children: React.ReactNode) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <ScreenReselectProvider>
        <Trigger />
        {children}
      </ScreenReselectProvider>,
    );
  });
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOffset = 0;
  mockFocused = true;
});

describe('isOffsetAtTop', () => {
  it('reads a screen with nothing to measure as the top', () => {
    expect(isOffsetAtTop(null)).toBe(true);
  });
  it('counts a few points of drift as the top, and anything past them as not', () => {
    expect(isOffsetAtTop(0)).toBe(true);
    expect(isOffsetAtTop(AT_TOP_THRESHOLD)).toBe(true);
    expect(isOffsetAtTop(AT_TOP_THRESHOLD + 1)).toBe(false);
  });
});

describe('reselecting the screen in front', () => {
  it('only scrolls back up when the reader is down the page', () => {
    const refresh = jest.fn();
    mockOffset = 800;
    render(<Screen handler={{ refresh }} />);
    act(() => reselect());
    expect(mockScrollToTop).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reloads when the reader is already at the top', () => {
    const refresh = jest.fn();
    render(<Screen handler={{ refresh }} />);
    act(() => reselect());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mockScrollToTop).toHaveBeenCalledTimes(1);
  });

  it('lets a screen that drives its own scroller decide where its top is', () => {
    const refresh = jest.fn();
    const scrollToTop = jest.fn();
    let atTop = false;
    render(<Screen handler={{ refresh, scrollToTop, isAtTop: () => atTop }} />);
    act(() => reselect());
    expect(scrollToTop).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    atTop = true;
    act(() => reselect());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mockScrollToTop).not.toHaveBeenCalled();
  });

  it('still scrolls when no screen has said how it reloads', () => {
    render(null);
    act(() => reselect());
    expect(mockScrollToTop).toHaveBeenCalledTimes(1);
  });

  it('never answers for a screen that is not in front', () => {
    const refresh = jest.fn();
    mockFocused = false;
    render(<Screen handler={{ refresh }} />);
    act(() => reselect());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps the newest screen when an older one unregisters late', () => {
    const older = jest.fn();
    const newer = jest.fn();
    const renderer = render(<Screen key="older" handler={{ refresh: older }} />);
    act(() => {
      renderer.update(
        <ScreenReselectProvider>
          <Trigger />
          <Screen key="older" handler={{ refresh: older }} />
          <Screen key="newer" handler={{ refresh: newer }} />
        </ScreenReselectProvider>,
      );
    });
    act(() => {
      renderer.update(
        <ScreenReselectProvider>
          <Trigger />
          <Screen key="newer" handler={{ refresh: newer }} />
        </ScreenReselectProvider>,
      );
    });
    act(() => reselect());
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
  });

  it('calls the handler the screen rendered last, not the one it registered with', () => {
    const first = jest.fn();
    const second = jest.fn();
    const renderer = render(<Screen handler={{ refresh: first }} />);
    act(() => {
      renderer.update(
        <ScreenReselectProvider>
          <Trigger />
          <Screen handler={{ refresh: second }} />
        </ScreenReselectProvider>,
      );
    });
    act(() => reselect());
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

describe('useTabSelect', () => {
  it('reselects the active tab and selects any other one', () => {
    const select = jest.fn();
    let press!: (tab: string) => void;
    function Strip() {
      press = useTabSelect<string>('for_you', select);
      return null;
    }
    const refresh = jest.fn();
    render(<><Screen handler={{ refresh }} /><Strip /></>);
    act(() => press('following'));
    expect(select).toHaveBeenCalledWith('following');
    expect(refresh).not.toHaveBeenCalled();
    act(() => press('for_you'));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe('useReselectReloadKey', () => {
  it('moves the key and runs the screen’s own reload with it', () => {
    const refresh = jest.fn();
    let reloadKey = -1;
    function Feed() {
      reloadKey = useReselectReloadKey({ refresh });
      return null;
    }
    render(<Feed />);
    expect(reloadKey).toBe(0);
    act(() => reselect());
    expect(reloadKey).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the screen’s own top', () => {
    const scrollToTop = jest.fn();
    let reloadKey = -1;
    function Reel() {
      reloadKey = useReselectReloadKey({ isAtTop: () => false, scrollToTop });
      return null;
    }
    render(<Reel />);
    act(() => reselect());
    expect(scrollToTop).toHaveBeenCalledTimes(1);
    expect(reloadKey).toBe(0);
  });
});
