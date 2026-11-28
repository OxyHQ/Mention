// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/// <reference types="expo/types/metro-require" />
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
