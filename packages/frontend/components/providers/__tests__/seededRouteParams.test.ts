import { BaseRouter } from 'expo-router/build/react-navigation/routers/BaseRouter';
import type { RouterRegistry } from 'expo-router/build/global-state/routerRegistry';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useNavigationTreeReducer } from 'expo-router/build/global-state/useNavigationTreeReducer';
import type { RouteNode } from 'expo-router/build/Route';
import {
  completeNavigationState,
  createSeededNavigationState,
} from 'expo-router/build/global-state/createSeededNavigationState';

const leaf = (route: string): RouteNode => ({
  route,
  type: 'route',
  dynamic: null,
  contextKey: `./${route}.tsx`,
  children: [],
  loadRoute: () => ({}),
});
const layout = (route: string, children: RouteNode[]): RouteNode => ({
  route,
  type: 'layout',
  dynamic: null,
  contextKey: `./${route}/_layout.tsx`,
  children,
  loadRoute: () => ({}),
});
const profile = layout('[username]', [leaf('index'), leaf('replies')]);

describe('Expo Router nested default route params', () => {
  it('seeds the default child with the destination layout params', () => {
    const state = createSeededNavigationState(undefined, profile, '0-0', {
      username: '@nate',
    });
    expect(state.routes[state.index].params).toEqual({ username: '@nate' });
  });
  it('retains layout params when restoring a route whose child state was removed', () => {
    const rootNode = layout('', [profile]);
    const state = completeNavigationState(
      {
        index: 0,
        routes: [
          {
            name: '__root',
            state: {
              index: 0,
              routes: [{ name: '[username]', params: { username: '@nate' } }],
            },
          },
        ],
      },
      rootNode,
    );
    expect(state.routes[0].state?.routes[0].state?.routes[0].params).toEqual({ username: '@nate' });
  });
  it('forwards params through multiple newly seeded layout levels', () => {
    const nested = layout('[username]', [layout('(profile)', [leaf('index')])]);
    const state = createSeededNavigationState(undefined, nested, '0-0', { username: '@nate' });
    expect(state.routes[0].state?.routes[0].params).toEqual({ username: '@nate' });
  });

  it('restores each retained profile using its own params', () => {
    const rootNode = layout('', [profile]);
    const state = completeNavigationState(
      {
        index: 0,
        routes: [
          {
            name: '__root',
            state: {
              index: 1,
              routes: [
                { name: '[username]', params: { username: '@nate' } },
                { name: '[username]', params: { username: '@other' } },
              ],
            },
          },
        ],
      },
      rootNode,
    );
    expect(state.routes[0].state?.routes.map((route) => route.state?.routes[0].params)).toEqual([
      { username: '@nate' },
      { username: '@other' },
    ]);
  });

  it.each([
    ['[username]', 'replies'],
    ['(tabs)', 'notifications'],
  ])('retains %s selection %s when its navigator unregisters', (routeName, selectedChild) => {
    const profile = layout(routeName, [leaf('index'), leaf(selectedChild)]);
    const rootNode = layout('', [profile]);
    const initialState = completeNavigationState(
      {
        index: 0,
        routes: [
          {
            name: '__root',
            state: {
              index: 0,
              routes: [
                {
                  name: routeName,
                  params: { username: '@nate' },
                  state: {
                    index: 0,
                    routes: [{ name: 'index', params: { username: '@nate' } }],
                  },
                },
                {
                  name: routeName,
                  params: { username: '@other' },
                  state: {
                    index: 0,
                    routes: [{ name: selectedChild, params: { username: '@other' } }],
                  },
                },
              ],
            },
          },
        ],
      },
      rootNode,
    );
    const childState = initialState.routes[0]?.state?.routes[1]?.state;
    if (!childState?.key) throw new Error('Expected a seeded profile navigator');
    const stateKey = childState.key;
    const registry: RouterRegistry = new Map([
      [childState.key, { routeNode: profile, reduce: () => null }],
    ]);
    const results: ReturnType<typeof useNavigationTreeReducer>[] = [];
    function Probe({ registry }: { registry: RouterRegistry }) {
      results.push(
        useNavigationTreeReducer({
          initialState,
          routeNode: rootNode,
          registry,
        }),
      );
      return null;
    }
    const mounted: { renderer?: ReactTestRenderer } = {};
    act(() => {
      mounted.renderer = create(React.createElement(Probe, { registry }));
    });
    const renderer = mounted.renderer;
    if (!renderer) throw new Error('Expected a mounted reducer probe');
    act(() => {
      renderer.update(React.createElement(Probe, { registry: new Map() }));
    });
    const result = results.at(-1);
    if (!result) throw new Error('Expected the navigation reducer to render');
    expect(
      result.state.routes[0].state?.routes.map((route) => ({
        name: route.state?.routes[0].name,
        params: route.state?.routes[0].params,
      })),
    ).toEqual([
      { name: 'index', params: { username: '@nate' } },
      { name: selectedChild, params: { username: '@other' } },
    ]);
    expect(result.state).toBe(initialState);
    act(() => {
      renderer.update(React.createElement(Probe, { registry }));
    });
    const remounted = results.at(-1);
    if (!remounted) throw new Error('Expected a remounted navigator');
    expect(remounted.state).toBe(initialState);
    act(() => {
      remounted.resetNavigator(stateKey, 'tab');
    });
    const reconfigured = results.at(-1);
    if (!reconfigured) throw new Error('Expected reconfigured navigation');
    expect(reconfigured.state.routes[0].state?.routes[1].state?.type).toBe('tab');
    expect(reconfigured.state.routes[0].state?.routes[1].state?.routes[0].name).toBe(selectedChild);
    act(() => {
      renderer.unmount();
    });
  });

  it('keeps an empty root valid after its last registry entry unregisters', () => {
    const rootNode = layout('', []);
    const initialState = createSeededNavigationState(undefined, rootNode, '0');
    const registry: RouterRegistry = new Map([
      [initialState.key, { routeNode: rootNode, reduce: () => null }],
    ]);
    const states: ReturnType<typeof useNavigationTreeReducer>['state'][] = [];
    function Probe({ registry }: { registry: RouterRegistry }) {
      states.push(useNavigationTreeReducer({ initialState, routeNode: rootNode, registry }).state);
      return null;
    }
    const mounted: { renderer?: ReactTestRenderer } = {};
    act(() => {
      mounted.renderer = create(React.createElement(Probe, { registry }));
    });
    const renderer = mounted.renderer;
    if (!renderer) throw new Error('Expected a root navigator probe');
    act(() => {
      renderer.update(React.createElement(Probe, { registry: new Map() }));
    });
    expect(states.at(-1)).toBe(initialState);
    expect(states.at(-1)?.routes).toEqual([]);
    expect(states.at(-1)?.index).toBe(-1);
    act(() => {
      renderer.update(React.createElement(Probe, { registry }));
    });
    expect(states.at(-1)).toBe(initialState);
    act(() => {
      renderer.unmount();
    });
  });

  it('still honors explicit resets and removes routes no longer declared', () => {
    const state = createSeededNavigationState(
      { index: 1, routes: [{ name: 'index' }, { name: 'replies', params: { username: '@nate' } }] },
      profile,
      '0-0',
    );
    const router = BaseRouter({});
    const reset = router.getStateForAction(
      state,
      {
        type: 'RESET',
        payload: createSeededNavigationState(undefined, profile, '0-0'),
      },
      { routeNames: ['index', 'replies'], routeGetIdList: {} },
    );
    if (typeof reset === 'string') throw new Error('Expected RESET to be handled');
    expect(reset.state.routes.map((route) => route.name)).toEqual(['index']);
    const filtered = router.getStateForDeclaredRoutes(state, ['index']);
    expect(filtered.routes.map((route) => route.name)).toEqual(['index']);
    expect(filtered.index).toBe(0);
  });

  it('keeps explicit sibling params separate from a previous destination', () => {
    const state = createSeededNavigationState(
      {
        index: 0,
        routes: [{ name: 'replies', params: { username: '@other', filter: 'new' } }],
      },
      profile,
      '0-0',
      { username: '@nate', oldQuery: 'stale' },
    );
    expect(state.routes[state.index].params).toEqual({ username: '@other', filter: 'new' });
  });
});
