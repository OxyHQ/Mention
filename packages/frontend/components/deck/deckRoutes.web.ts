import { createDeckRouteRegistry } from './deckRouteRegistry';

// Metro splits the same app screens into real asynchronous chunks. The registry
// names routes at startup, but only an opened panel loads its screen/layouts.
const modules = require.context(
  '../../app/(app)',
  true,
  /^(?!.*(?:__tests__|\.test\.|\.spec\.)).*\.tsx$/,
  'lazy',
);
const registry = createDeckRouteRegistry(modules);
export const deckRoutes = registry.routes;
export const retryFailedDeckRoutes = registry.retryFailed;
