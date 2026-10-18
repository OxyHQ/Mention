import React, { Component, Suspense, type ComponentType, type ReactNode } from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { createDeckRouteRegistry } from '../deckRouteRegistry';
type RouteModule = { default: ComponentType };
const Page = () => <Text>Loaded page</Text>;
function context(files: string[], load: (file: string) => Promise<RouteModule>) {
  return Object.assign(jest.fn(load), { keys: () => files });
}
function deferred() {
  const controls: {
    resolve?: (value: RouteModule) => void;
    reject?: (reason: Error) => void;
  } = {};
  const promise = new Promise<RouteModule>((yes, no) => {
    controls.resolve = yes;
    controls.reject = no;
  });
  const { resolve, reject } = controls;
  if (!resolve || !reject) throw new Error('Deferred promise controls were not initialized');
  return { promise, resolve, reject };
}
const pendingUI = <Text>Loading skeleton</Text>;
class Boundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? <Text>Failed route</Text> : this.props.children;
  }
}

test('does not import screens at startup; shares resolved routes across panels and revisits', async () => {
  const request = deferred();
  const modules = context(['./explore/index.tsx', './saved.tsx'], () => request.promise);
  const registry = createDeckRouteRegistry(modules);
  const route = registry.routes.find((candidate) => candidate.path === '/explore');
  if (!route) throw new Error('Explore route is missing');
  const Route = route.component;
  expect(modules).not.toHaveBeenCalled();
  const rendered: { current?: TestRenderer.ReactTestRenderer } = {};
  await act(async () => {
    rendered.current = TestRenderer.create(
      <Suspense fallback={pendingUI}>
        <Route />
        <Route />
      </Suspense>,
    );
  });
  const view = rendered.current;
  if (!view) throw new Error('Explore renderer was not created');
  expect(modules).toHaveBeenCalledTimes(1);
  expect(modules).toHaveBeenCalledWith('./explore/index.tsx');
  expect(JSON.stringify(view.toJSON())).toContain('Loading skeleton');
  await act(async () => {
    request.resolve({ default: Page });
  });
  expect(JSON.stringify(view.toJSON())).toContain('Loaded page');
  await act(async () => {
    view.update(
      <Suspense fallback={pendingUI}>
        <Route key="revisited" />
      </Suspense>,
    );
  });
  expect(JSON.stringify(view.toJSON())).not.toContain('Loading skeleton');
  expect(modules).toHaveBeenCalledTimes(1);
  await act(async () => view.unmount());
});

test('selects web screens, preserves nested layout identities, excludes Deck and special routes', async () => {
  const modules = context(
    [
      './_layout.tsx',
      './(tabs)/_layout.tsx',
      './(tabs)/index.tsx',
      './(tabs)/index.web.tsx',
      './(tabs)/index.native.tsx',
      './[username]/_layout.tsx',
      './[username]/lane/_layout.tsx',
      './[username]/lane/[id].tsx',
      './[username]/lane/index.tsx',
      './deck.tsx',
      './+not-found.tsx',
    ],
    async () => ({ default: Page }),
  );
  const { routes } = createDeckRouteRegistry(modules);
  expect(routes.map((route) => route.path)).toEqual([
    '/',
    '/[username]/lane/[id]',
    '/[username]/lane',
  ]);
  const [home, detail, index] = routes;
  if (!home || !detail || !index) throw new Error('Expected Home and both nested routes');
  const detailLayouts = detail.layouts;
  const indexLayouts = index.layouts;
  if (!detailLayouts || !indexLayouts) throw new Error('Nested route layouts are missing');
  expect(detailLayouts).toHaveLength(2);
  expect(indexLayouts).toHaveLength(2);
  expect(detailLayouts[0]).toBe(indexLayouts[0]);
  expect(detailLayouts[1]).toBe(indexLayouts[1]);
  const Home = home.component;
  const rendered: { current?: TestRenderer.ReactTestRenderer } = {};
  await act(async () => {
    rendered.current = TestRenderer.create(
      <Suspense fallback={pendingUI}>
        <Home />
      </Suspense>,
    );
  });
  const view = rendered.current;
  if (!view) throw new Error('Home renderer was not created');
  expect(modules).toHaveBeenCalledWith('./(tabs)/index.web.tsx');
  expect(modules).toHaveBeenCalledTimes(1);
  await act(async () => view.unmount());
});

test('a rejected chunk reaches the error boundary and explicit retry loads it again', async () => {
  const request = deferred();
  const modules = context(['./saved.tsx'], () => request.promise);
  const registry = createDeckRouteRegistry(modules);
  const route = registry.routes[0];
  if (!route) throw new Error('Saved route is missing');
  const Route = route.component;
  const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  const rendered: { current?: TestRenderer.ReactTestRenderer } = {};
  try {
    await act(async () => {
      rendered.current = TestRenderer.create(
        <Boundary>
          <Suspense fallback={pendingUI}>
            <Route />
          </Suspense>
        </Boundary>,
      );
    });
    const view = rendered.current;
    if (!view) throw new Error('Saved renderer was not created');
    await act(async () => {
      request.reject(new Error('Chunk unavailable'));
    });
    expect(JSON.stringify(view.toJSON())).toContain('Failed route');
    expect(JSON.stringify(view.toJSON())).not.toContain('Loading skeleton');
    expect(modules).toHaveBeenCalledTimes(1);
    modules.mockImplementation(async () => ({ default: Page }));
    registry.retryFailed();
    await act(async () => {
      view.update(
        <Boundary key="retry">
          <Suspense fallback={pendingUI}>
            <Route />
          </Suspense>
        </Boundary>,
      );
    });
    expect(JSON.stringify(view.toJSON())).toContain('Loaded page');
    expect(modules).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => rendered.current?.unmount());
    errorLog.mockRestore();
  }
});
