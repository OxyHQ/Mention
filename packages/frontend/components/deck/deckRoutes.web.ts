import { createElement, type ComponentType } from 'react';
import type { PanelRouteDefinition } from '@oxy.so/bloom/panel-routing';

// The same screens and route layouts as the main app; only the navigation host differs.
const modules = require.context(
  '../../app/(app)',
  true,
  /^(?!.*(?:__tests__|\.test\.|\.spec\.)).*\.tsx$/,
);
const files = new Map<string, string>();
for (const key of modules.keys()) {
  if (/\.(native|ios|android)\.tsx$/.test(key)) continue;
  const route = key.replace(/^\.\//, '').replace(/(?:\.web)?\.tsx$/, '');
  if (!files.has(route) || key.endsWith('.web.tsx')) files.set(route, key);
}
const components = new Map<string, ComponentType>();
function component(file: string): ComponentType {
  let screen = components.get(file);
  if (!screen) {
    screen = function PanelScreenRoute() {
      const Screen = (modules(file) as { default: ComponentType }).default;
      return createElement(Screen);
    };
    components.set(file, screen);
  }
  return screen;
}
export const deckRoutes: readonly PanelRouteDefinition[] = [...files].flatMap(([file, key]) => {
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
