import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { TabPagerProvider, useTabPager, type TabCommitter } from '@/context/TabPagerContext';

/**
 * The one authority on which root tab is showing and where the bar's highlight
 * sits.
 *
 * What is worth pinning here is the SEPARATION the whole design rests on:
 * `activeIndex` answers whether there is a selection, `progress` answers where
 * it is, and each has exactly one writer. Bloom's `TabBar` reads them as two
 * different questions (`docs/tab-bar.mdx`), so the two failure modes this file
 * guards are a capsule parked outside the pill on a pushed route, and two
 * writers fighting over the position while a finger is on the screen.
 *
 * The provider replaced a `usePathname()`-derived index that could not update
 * until the incoming screen had finished rendering — the reported "it changes a
 * few seconds later". So the other thing pinned here is that `selectTab` moves
 * the highlight when the reader ACTS, not when the route lands.
 */

let mockPathname = '/';
const mockRouter = {
  canDismiss: jest.fn(() => false),
  dismissAll: jest.fn(),
  navigate: jest.fn(),
  prefetch: jest.fn(),
};

jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  get router() {
    return mockRouter;
  },
}));

let mockUsername: string | undefined;
jest.mock('@oxyhq/services/ui/client', () => ({
  useAuth: () => ({ user: mockUsername ? { username: mockUsername } : undefined }),
}));

/**
 * Reanimated's worklet runtime is not initialized under jest-expo. `progress` is
 * a plain mutable holder, and `withSpring` returns its target — so a test reads
 * the value the animation would SETTLE on. That is the right resolution for
 * these assertions: which tab the highlight ends up over, and whether anything
 * wrote to it at all. The motion itself belongs to a device.
 */
jest.mock('react-native-reanimated', () => {
  // The box must be STABLE across renders, as the real `useSharedValue` is — a
  // shared value is a persistent holder, and the provider writes to it from an
  // effect and from `selectTab` and expects to read those writes back. A fresh
  // object per render would reset it silently and make every assertion about
  // "what the highlight settled on" measure the mock instead of the provider.
  const { useRef } = require('react') as typeof import('react');
  return {
    useSharedValue: (initial: number) => {
      const ref = useRef<{ value: number } | null>(null);
      if (ref.current === null) ref.current = { value: initial };
      return ref.current;
    },
    withSpring: (target: number) => target,
  };
});

function mountProvider() {
  const seen: { current: ReturnType<typeof useTabPager> | null } = { current: null };
  const Probe = () => {
    seen.current = useTabPager();
    return null;
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <TabPagerProvider>
        <Probe />
      </TabPagerProvider>,
    );
  });
  const repaint = () => {
    act(() => {
      renderer?.update(
        <TabPagerProvider>
          <Probe />
        </TabPagerProvider>,
      );
    });
  };
  return {
    get value() {
      if (!seen.current) throw new Error('the provider never rendered its children');
      return seen.current;
    },
    repaint,
  };
}

beforeEach(() => {
  mockPathname = '/';
  mockUsername = undefined;
  mockRouter.canDismiss.mockReset().mockReturnValue(false);
  mockRouter.dismissAll.mockReset();
  mockRouter.navigate.mockReset();
  mockRouter.prefetch.mockReset();
});

describe('activeIndex answers WHETHER there is a selection', () => {
  it('names the tab the reader is on', () => {
    mockPathname = '/notifications';
    expect(mountProvider().value.activeIndex).toBe(3);
  });

  it('is -1 on a route pushed over the tabs', () => {
    // The bar renders over pushed routes, so this is the common case, and it is
    // what makes Bloom fade the capsule out rather than park it outside the pill.
    mockPathname = '/p/abc123';
    expect(mountProvider().value.activeIndex).toBe(-1);
  });
});

describe('progress answers WHERE the highlight is', () => {
  it('settles on the tab the route named', () => {
    mockPathname = '/videos';
    expect(mountProvider().value.progress.value).toBe(1);
  });

  it('NEVER takes -1, even when nothing is selected', () => {
    // -1 is a real POSITION — one item-width left of the first tab, half outside
    // the pill — not an absence. Writing it would drag the capsule off the end
    // on its way out instead of fading it where it stands.
    mockPathname = '/videos';
    const bar = mountProvider();
    expect(bar.value.progress.value).toBe(1);

    mockPathname = '/settings';
    bar.repaint();

    expect(bar.value.activeIndex).toBe(-1);
    expect(bar.value.progress.value).toBe(1);
  });

  it('follows a navigation it did not perform', () => {
    // A deep link, a push notification, a browser Back. Nothing else moves the
    // highlight on those paths when no pager is mounted.
    const bar = mountProvider();
    mockPathname = '/you';
    bar.repaint();
    expect(bar.value.progress.value).toBe(4);
  });
});

describe('selectTab', () => {
  it('moves the highlight and navigates when no navigator is registered', () => {
    const bar = mountProvider();

    act(() => {
      bar.value.selectTab(3);
    });

    expect(bar.value.progress.value).toBe(3);
    expect(mockRouter.navigate).toHaveBeenCalledWith('/notifications');
  });

  it('pops what is pushed over the tabs BEFORE switching', () => {
    // Without this the navigator would change the tab underneath while the
    // reader kept looking at the post they opened.
    mockPathname = '/p/abc123';
    mockRouter.canDismiss.mockReturnValue(true);
    const bar = mountProvider();

    act(() => {
      bar.value.selectTab(0);
    });

    expect(mockRouter.dismissAll).toHaveBeenCalled();
  });

  it('does not try to pop when there is nothing pushed', () => {
    const bar = mountProvider();
    act(() => {
      bar.value.selectTab(1);
    });
    expect(mockRouter.dismissAll).not.toHaveBeenCalled();
  });

  it('hands the switch to the navigator once one registers, instead of navigating', () => {
    // The tab router's own move: no route push, so a swipe leaves no history
    // entry per page and the tab being left is not unmounted.
    const bar = mountProvider();
    const committer: TabCommitter = { commit: jest.fn(), drivesProgress: true };
    act(() => {
      bar.value.registerCommitter(committer);
    });

    act(() => {
      bar.value.selectTab(2);
    });

    expect(committer.commit).toHaveBeenCalledWith(2);
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  it('leaves progress alone while the pager owns it', () => {
    // The pager writes `progress` every frame from the UI thread. A spring
    // started here would be a second writer racing the finger.
    mockPathname = '/';
    const bar = mountProvider();
    act(() => {
      bar.value.registerCommitter({ commit: jest.fn(), drivesProgress: true });
    });

    act(() => {
      bar.value.selectTab(4);
    });

    expect(bar.value.progress.value).toBe(0);
  });

  it('still moves progress for a navigator that does NOT drive it', () => {
    const bar = mountProvider();
    act(() => {
      bar.value.registerCommitter({ commit: jest.fn(), drivesProgress: false });
    });

    act(() => {
      bar.value.selectTab(4);
    });

    expect(bar.value.progress.value).toBe(4);
  });

  it('ignores an index that names no tab', () => {
    const bar = mountProvider();
    act(() => {
      bar.value.selectTab(99);
    });
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  it('goes back to navigating once the navigator unregisters', () => {
    const bar = mountProvider();
    act(() => {
      bar.value.registerCommitter({ commit: jest.fn(), drivesProgress: true });
    });
    act(() => {
      bar.value.registerCommitter(null);
    });

    act(() => {
      bar.value.selectTab(1);
    });

    expect(mockRouter.navigate).toHaveBeenCalledWith('/videos');
  });
});

describe('useTabPager outside the provider', () => {
  it('throws rather than handing out a silent fallback', () => {
    const Orphan = () => {
      useTabPager();
      return null;
    };
    // React logs the error it re-throws; the assertion is about the throw, not
    // about the noise it makes on the way out.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => {
        act(() => {
          TestRenderer.create(<Orphan />);
        });
      }).toThrow(/TabPagerProvider/);
    } finally {
      consoleError.mockRestore();
    }
  });
});
