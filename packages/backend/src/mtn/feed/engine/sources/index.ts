// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Source-module registration. Registers every wrapped candidate source into a
 * {@link FeedModuleRegistry} (the shared singleton by default).
 */

import { feedModuleRegistry, type FeedModuleRegistry } from '../FeedModuleRegistry';
import { forYouSourceModules } from './forYouSources';
import { discoverySourceModules } from './discoverySources';
import { userSourceModules } from './userSources';
import { socialSourceModules } from './socialSources';
import { relatedSourceModules } from './relatedSources';
import { promotionSource } from './promotionSource';

export function registerSourceModules(registry: FeedModuleRegistry = feedModuleRegistry): void {
  for (const module of [
    ...forYouSourceModules,
    ...discoverySourceModules,
    ...userSourceModules,
    ...socialSourceModules,
    ...relatedSourceModules,
    promotionSource,
  ]) {
    registry.register(module);
  }
}

export { forYouSourceModules } from './forYouSources';
export { discoverySourceModules } from './discoverySources';
export { userSourceModules } from './userSources';
export { socialSourceModules } from './socialSources';
export { relatedSourceModules } from './relatedSources';
export { promotionSource } from './promotionSource';
