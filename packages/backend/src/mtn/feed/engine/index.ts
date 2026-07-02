/**
 * Feed engine public surface + startup registration.
 *
 * `registerAllModules()` registers every source / signal / filter module into
 * the shared {@link feedModuleRegistry}. Called once at server startup (replaces
 * the old `registerAllFeeds()`), after which `resolveDefinition` + `feedEngine`
 * serve every feed.
 */

import { feedModuleRegistry, FeedModuleRegistry } from './FeedModuleRegistry';
import { registerSourceModules } from './sources';
import { registerSignalModules } from './signals';
import { registerFilterModules } from './filters';

export function registerAllModules(registry: FeedModuleRegistry = feedModuleRegistry): void {
  registerSourceModules(registry);
  registerSignalModules(registry);
  registerFilterModules(registry);
}

export { feedEngine, FeedEngine } from './FeedEngine';
export { feedModuleRegistry, FeedModuleRegistry } from './FeedModuleRegistry';
