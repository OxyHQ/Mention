import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

import { TABS } from '@/components/navigation/tabs';
import { TabsPager } from '@/components/navigation/TabsPager';

/**
 * The pager's pages are TABS pages, whatever order the navigator keeps.
 *
 * THE ORDERS ARE NOT THE SAME ONE, and that is upstream behaviour rather than a
 * local slip: expo-router builds the navigator's routes with
 * `sortRoutesWithInitial` (`node_modules/expo-router/build/ui/common.js`), which
 * puts `index` first and then sorts by route-name LENGTH — so a `TABS` written
 * as home/videos/write/notifications/you reaches `useTabsWithTriggers` and comes
 * back as index/you/write/videos/notifications. The trigger order is not
 * preserved and nothing in the API says it would be.
 *
 * Everything outside this component speaks in `TABS` indices: `progress` is the
 * bar highlight's position in tab units, `activeIndex` comes from
 * `tabIndexForPathname`, and `selectTab`/`commit` look the tab up in `TABS`. So
 * a page index that is anything OTHER than a `TABS` index is a swipe landing on
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

jest.mock('react-native-screens', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  return {
    Screen: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(View, null, children),
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
 * `TabsPager` warms its neighbours through `InteractionManager`, so a mount left
 * standing has a callback still queued when the test ends. It fires against a
 * torn-down jest environment, jest reports "Cannot log after tests are done" /
 * "trying to `import` a file after the Jest environment has been torn down",
 * and the RUN exits non-zero while every suite is reported green — which is how
 * this arrived, as a red CI job over 187 passing suites.
 */
const mounted: TestRenderer.ReactTestRenderer[] = [];

afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) renderer.unmount();
  });
});

function mountPager(focusedName: string) {
  const routes = NAVIGATOR_ROUTE_NAMES.map((name) => ({ key: `key-${name}`, name }));
  const descriptors = Object.fromEntries(
    routes.map((route) => [
      route.key,
      { render: () => React.createElement(Text, null, route.name) },
    ]),
  );
  const onCommit = jest.fn();
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <TabsPager
        state={{ index: routes.findIndex((route) => route.name === focusedName), routes }}
        descriptors={descriptors}
        progress={{ value: 0 } as never}
        onCommit={onCommit}
      />,
    );
  });
  if (!renderer) throw new Error('renderer did not mount');
  mounted.push(renderer);
  return { renderer, onCommit };
}

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
  it('lays its pages out in TABS order, not the navigator route order', () => {
    const { renderer } = mountPager('videos');

    expect(renderedPageNames(renderer)[TABS.findIndex((tab) => tab.name === 'videos')]).toBe(
      'videos',
    );
  });

  it('opens on the focused tab as a TABS index', () => {
    mountPager('videos');

    expect(pagerProps.initialPage).toBe(TABS.findIndex((tab) => tab.name === 'videos'));
  });

  it('commits the TABS index of the page the reader landed on', () => {
    const youIndex = TABS.findIndex((tab) => tab.name === 'you');
    const { onCommit } = mountPager('index');

    act(() => {
      (pagerProps.onPageSelected as (event: { nativeEvent: { position: number } }) => void)({
        nativeEvent: { position: youIndex },
      });
    });

    expect(onCommit).toHaveBeenCalledWith(youIndex);
  });
});
