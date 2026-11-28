// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Feed engine public surface + startup registration.
 *
 * `registerAllModules()` registers every source / signal / filter module into
 * the shared {@link feedModuleRegistry}. Called once at server startup (replaces
 * the old `registerAllFeeds()`), after which `resolveDefinition` + `feedEngine`
 * serve every feed.
 */

import { feedModuleRegistry, type FeedModuleRegistry } from './FeedModuleRegistry';
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
