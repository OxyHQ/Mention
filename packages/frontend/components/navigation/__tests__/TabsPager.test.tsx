import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

import { PAGES } from '@/components/navigation/tabs';
import { TabsPager } from '@/components/navigation/TabsPager';

/**
 * The pager's pages are PAGES pages, whatever order the navigator keeps.
 *
 * THE ORDERS ARE NOT THE SAME ONE, and that is upstream behaviour rather than a
 * local slip: expo-router builds the navigator's routes with
 * `sortRoutesWithInitial` (`node_modules/expo-router/build/ui/common.js`), which
 * puts `index` first and then sorts by route-name LENGTH — so a `PAGES` written
 * as home/videos/write/notifications/you reaches `useTabsWithTriggers` and comes
 * back as index/you/write/videos/notifications. The trigger order is not
 * preserved and nothing in the API says it would be.
 *
 * Everything outside this component speaks in `PAGES` indices: `progress` is the
 * bar highlight's position in tab units, `activeIndex` comes from
 * `pageIndexForPathname`, and `selectTab`/`commit` look the page up in `PAGES`.
 * So a page index that is anything OTHER than a `PAGES` index is a swipe landing on
 * one screen while the bar highlights another, and a tap moving the pager to a
 * page belonging to someone else.
 *
 * These assertions are written in names, never in positions of the incoming
 * `state.routes`, because the sort above is upstream's to change again.
 */

let pagerProps: Record<string, unknown> = {};

jest.mock('react-native-pager-view', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const MockPagerView = React.forwardRef<unknown, { children?: React.ReactNode }>(
    (props, _ref) => {
      pagerProps = props as Record<string, unknown>;
      return React.createElement(View, null, props.children);
    },
  );
  MockPagerView.displayName = 'MockPagerView';
  return { __esModule: true, default: MockPagerView };
});

/**
 * A `Screen` that costs what the real one costs.
 *
 * `app/_layout.tsx` calls `enableFreeze(true)`, and react-native-screens reads
 * that global as the default for `freezeOnBlur` — so `activityState === 0` wraps
 * the page in react-freeze and its subtree is not rendered at all. A page
 * therefore appears in `renderedPageNames` exactly when it is LIVE, and a page
 * that appears where it did not before is a thaw: a whole screen's render, and
 * its native views mounted again.
 *
 * The state is put on the view too, because "which band is live" is the thing
 * being asserted and reading it back is more honest than inferring it.
 */
jest.mock('react-native-screens', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  return {
    Screen: ({
      activityState,
      children,
    }: {
      activityState: number;
      children?: React.ReactNode;
    }) =>
      React.createElement(
        View,
        { testID: `activity-${activityState}` },
        activityState === 0 ? null : children,
      ),
  };
});

/**
 * Reanimated's worklet runtime is not initialized under jest-expo, and none of
 * it is what this file measures: `onPageScroll` runs on the UI thread on a
 * device. `createAnimatedComponent` is identity so the mocked pager above is
 * what actually renders.
 */
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { createAnimatedComponent: (component: unknown) => component },
  useEvent: () => jest.fn(),
  useHandler: () => ({ doDependenciesDiffer: false }),
}));

/** The navigator's own order, as expo-router's sort produces it. */
const NAVIGATOR_ROUTE_NAMES = ['index', 'you', 'write', 'videos', 'notifications'] as const;

/**
 * Every mount is torn down, and that is not tidiness.
 *
 * A mount left standing keeps the pager's effects alive past the end of the
 * test. They fire against a torn-down jest environment, jest reports "Cannot log
 * after tests are done" / "trying to `import` a file after the Jest environment
 * has been torn down", and the RUN exits non-zero while every suite is reported
 * green — which is how this arrived, as a red CI job over 187 passing suites.
 */
const mounted: TestRenderer.ReactTestRenderer[] = [];

afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) renderer.unmount();
  });
});

function mountPager(focusedName: string) {
  const routes = NAVIGATOR_ROUTE_NAMES.map((name) => ({ key: `key-${name}`, name }));
  const onCommit = jest.fn();
  // A fresh descriptors object per render, because `useDescriptors` builds one
  // per navigator render and a memo that held on to the old one would be
  // measuring the test rather than the component.
  const element = (focused: string) => (
    <TabsPager
      state={{ index: routes.findIndex((route) => route.name === focused), routes }}
      descriptors={Object.fromEntries(
        routes.map((route) => [
          route.key,
          { render: () => React.createElement(Text, null, route.name) },
        ]),
      )}
      progress={{ value: 0 } as never}
      chromeProgress={{ value: 0 } as never}
      onCommit={onCommit}
    />
  );
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(element(focusedName));
  });
  if (!renderer) throw new Error('renderer did not mount');
  const created = renderer;
  mounted.push(created);
  /** The navigator focusing another tab — a bar tap, a deep link, a back gesture. */
  const focus = (name: string) => {
    act(() => {
      created.update(element(name));
    });
  };
  /** What the pager reports once it has stopped moving. */
  const settle = () => {
    act(() => {
      (
        pagerProps.onPageScrollStateChanged as (event: {
          nativeEvent: { pageScrollState: string };
        }) => void
      )({ nativeEvent: { pageScrollState: 'idle' } });
    });
  };
  return { renderer: created, onCommit, focus, settle };
}

/**
 * A pager in the state the device measurement was taken in.
 *
 * The reported jank is an app that has been USED: every page that opts into
 * preloading is already mounted, so the only thing a tap can change is which of
 * them are live. From a cold pager nothing but the first page is admitted, a tap
 * has nothing to thaw, and the assertions below would pass while measuring
 * nothing. Visiting each tab is what admits it, exactly as a reader does.
 */
function mountWarmPager() {
  const pager = mountPager('index');
  for (const name of ['videos', 'notifications', 'you', 'index']) {
    pager.focus(name);
    pager.settle();
  }
  return pager;
}

/** Index of a page within `PAGES` — the unit every assertion here is written in. */
const pageOf = (name: string) => PAGES.findIndex((page) => page.name === name);

/**
 * The page at each position, named by the text its descriptor rendered.
 *
 * A page that has not been admitted yet renders an empty view and reads as
 * `null` — which is itself part of the contract, since a page that rendered
 * NOTHING would shift every page after it.
 */
function renderedPageNames(renderer: TestRenderer.ReactTestRenderer): (string | null)[] {
  const firstString = (node: TestRenderer.ReactTestRendererJSON | string): string | null => {
    if (typeof node === 'string') return node;
    for (const child of node.children ?? []) {
      const found = firstString(child);
      if (found !== null) return found;
    }
    return null;
  };
  const pager = renderer.toJSON();
  if (!pager || Array.isArray(pager)) throw new Error('pager did not render');
  return (pager.children ?? []).map(firstString);
}

describe('TabsPager', () => {
  it('lays its pages out in PAGES order, not the navigator route order', () => {
    const { renderer } = mountPager('videos');

    expect(renderedPageNames(renderer)[PAGES.findIndex((page) => page.name === 'videos')]).toBe(
      'videos',
    );
  });

  it('opens on the focused page as a PAGES index', () => {
    mountPager('videos');

    expect(pagerProps.initialPage).toBe(PAGES.findIndex((page) => page.name === 'videos'));
  });

  /**
   * THE COST OF A TAP IS THE PAGES IT THAWS, and there is exactly one it has to.
   *
   * Measured on a Pixel 10 Pro (`dumpsys gfxinfo`), four bar taps ran 8.87%
   * janky against 2.73% for scrolling the feed — p99 150ms, every janky frame a
   * slow UI-thread one. The band used to be measured from the FOCUSED page, so
   * it moved in the same commit as the tap and thawed two screens at once: the
   * destination, plus whichever page had just become its neighbour. Tapping Home
   * from the profile thawed the feed AND the reels screen together.
   *
   * Written as "which pages are live", because that is what a thaw costs and
   * what the mocked `Screen` above reproduces.
   */
  it('thaws only the destination on the commit a tab tap produces', () => {
    const { renderer, focus } = mountWarmPager();

    focus('notifications');

    const live = renderedPageNames(renderer);
    expect(live[pageOf('notifications')]).toBe('notifications');
    // Three pages away, so it was not live before the tap and has nothing to
    // show until the pager gets there.
    expect(live[pageOf('you')]).toBeNull();
  });

  it('moves the live band once the pager reports it has settled', () => {
    const { renderer, focus, settle } = mountWarmPager();

    focus('notifications');
    settle();

    // The band has caught up, so the next swipe in either direction has a real
    // page under the finger.
    expect(renderedPageNames(renderer)[pageOf('you')]).toBe('you');
  });

  it('keeps the page being left alive while the pager travels away from it', () => {
    const { renderer, focus } = mountWarmPager();

    focus('notifications');

    // The pager is still sliding across it. Freezing it on the tap's own commit
    // blanks the screen the reader is watching leave, and pays to thaw it again
    // the moment they tap back.
    expect(renderedPageNames(renderer)[pageOf('index')]).toBe('index');
  });

  it('commits the PAGES index of the page the reader landed on', () => {
    const youIndex = PAGES.findIndex((page) => page.name === 'you');
    const { onCommit } = mountPager('index');

    act(() => {
      (pagerProps.onPageSelected as (event: { nativeEvent: { position: number } }) => void)({
        nativeEvent: { position: youIndex },
      });
    });

    expect(onCommit).toHaveBeenCalledWith(youIndex);
  });
});
