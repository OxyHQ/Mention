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
  let resolve!: (value: RouteModule) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<RouteModule>((yes, no) => {
    resolve = yes;
    reject = no;
  });
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
  const Route = registry.routes.find((route) => route.path === '/explore')!.component;
  expect(modules).not.toHaveBeenCalled();
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    view = TestRenderer.create(
      <Suspense fallback={pendingUI}>
        <Route />
        <Route />
      </Suspense>,
    );
  });
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
  expect(routes[1].layouts).toHaveLength(2);
  expect(routes[1].layouts![0]).toBe(routes[2].layouts![0]);
  expect(routes[1].layouts![1]).toBe(routes[2].layouts![1]);
  const Home = routes[0].component;
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    view = TestRenderer.create(
      <Suspense fallback={pendingUI}>
        <Home />
      </Suspense>,
    );
  });
  expect(modules).toHaveBeenCalledWith('./(tabs)/index.web.tsx');
  expect(modules).toHaveBeenCalledTimes(1);
  await act(async () => view.unmount());
});

test('a rejected chunk reaches the error boundary and explicit retry loads it again', async () => {
  const request = deferred();
  const modules = context(['./saved.tsx'], () => request.promise);
  const registry = createDeckRouteRegistry(modules);
  const Route = registry.routes[0].component;
  const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  let view!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      view = TestRenderer.create(
        <Boundary>
          <Suspense fallback={pendingUI}>
            <Route />
          </Suspense>
        </Boundary>,
      );
    });
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
    await act(async () => view?.unmount());
    errorLog.mockRestore();
  }
});
