/**
 * Source-module registration. Registers every wrapped candidate source into a
 * {@link FeedModuleRegistry} (the shared singleton by default).
 */

import { feedModuleRegistry, FeedModuleRegistry } from '../FeedModuleRegistry';
import { forYouSourceModules } from './forYouSources';
import { discoverySourceModules } from './discoverySources';
import { userSourceModules } from './userSources';
import { socialSourceModules } from './socialSources';

export function registerSourceModules(registry: FeedModuleRegistry = feedModuleRegistry): void {
  for (const module of [
    ...forYouSourceModules,
    ...discoverySourceModules,
    ...userSourceModules,
    ...socialSourceModules,
  ]) {
    registry.register(module);
  }
}

export { forYouSourceModules } from './forYouSources';
export { discoverySourceModules } from './discoverySources';
export { userSourceModules } from './userSources';
export { socialSourceModules } from './socialSources';
