import { createElement, lazy, type ComponentType } from 'react';
import type { PanelRouteDefinition } from '@oxy.so/bloom/panel-routing';

type RouteModule = { default: ComponentType };
interface AsyncRouteContext {
  (file: string): Promise<RouteModule>;
  keys(): string[];
}

/** Share route identities and resolved modules across columns without importing screens at startup. */
export function createDeckRouteRegistry(modules: AsyncRouteContext) {
  const files = new Map<string, string>();
  for (const key of modules.keys()) {
    if (/\.(native|ios|android)\.tsx$/.test(key)) continue;
    const route = key.replace(/^\.\//, '').replace(/(?:\.web)?\.tsx$/, '');
    if (!files.has(route) || key.endsWith('.web.tsx')) files.set(route, key);
  }
  const components = new Map<string, { loadable: ComponentType; wrapper: ComponentType }>();
  const failed = new Set<string>();
  function loadable(file: string): ComponentType {
    return lazy(() =>
      modules(file).catch((error: unknown) => {
        failed.add(file);
        throw error;
      }),
    );
  }
  function component(file: string): ComponentType {
    let record = components.get(file);
    if (!record) {
      const item = {
        loadable: loadable(file),
        wrapper: function PanelScreenRoute() {
          return createElement(item.loadable);
        },
      };
      components.set(file, item);
      record = item;
    }
    return record.wrapper;
  }
  const routes: readonly PanelRouteDefinition[] = [...files].flatMap(([file, key]) => {
    if (
      file.split('/').some((segment) => segment.startsWith('+')) ||
      file.endsWith('_layout') ||
      file === 'deck'
    )
      return [];
    const parts = file.split('/');
    const layouts: ComponentType[] = [];
    for (let depth = 1; depth < parts.length; depth++) {
      const layout = files.get(`${parts.slice(0, depth).join('/')}/_layout`);
      if (layout) layouts.push(component(layout));
    }
    const path =
      `/${parts.filter((part) => !/^\(.+\)$/.test(part)).join('/')}`.replace(/\/index$/, '') || '/';
    return [{ path, component: component(key), layouts }];
  });

  return {
    routes,
    retryFailed() {
      for (const file of failed) {
        const record = components.get(file);
        if (record) record.loadable = loadable(file);
      }
      failed.clear();
    },
  };
}
