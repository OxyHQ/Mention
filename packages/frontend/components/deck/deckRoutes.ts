// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { PanelRouteDefinition } from '@oxy.so/bloom/panel-routing';
// Deck is desktop-only. Do not bundle another route graph into native apps.
export const deckRoutes: readonly PanelRouteDefinition[] = [];
export const retryFailedDeckRoutes = () => {};
