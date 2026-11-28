// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

// Base module for tsc / ESLint resolution.
// At bundle time, Metro resolves NotificationsList.native.tsx (FlashList + the
// LayoutScroll wheel bridge) on native and NotificationsList.web.tsx (window
// virtualizer under the document scroller, no wheel bridge) on web instead.
export { NotificationsList, type NotificationsListProps } from './NotificationsList.web';
