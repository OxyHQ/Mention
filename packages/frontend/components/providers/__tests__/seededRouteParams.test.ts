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

  it('keeps profile identity when its navigator unregisters and reseeds its default child', () => {
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
                  name: '[username]',
                  params: { username: '@nate' },
                  state: {
                    index: 0,
                    routes: [{ name: 'index', params: { username: '@nate' } }],
                  },
                },
                {
                  name: '[username]',
                  params: { username: '@other' },
                  state: {
                    index: 0,
                    routes: [{ name: 'replies', params: { username: '@other' } }],
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
      { name: 'index', params: { username: '@other' } },
    ]);
    act(() => {
      renderer.unmount();
    });
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
