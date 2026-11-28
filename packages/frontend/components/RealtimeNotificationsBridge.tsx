// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * RealtimeNotificationsBridge Component
 *
 * Keeps the notifications socket connected app-wide (mounted under OxyProvider so
 * `useAuth` resolves), independent of whether the notifications screen is open.
 * This is what lets the bell badge update live from anywhere in the app. Mount it
 * exactly ONCE — the socket is a module singleton, so a second mount would double
 * every listener.
 */

import { useRealtimeNotifications } from '@/hooks/useRealtimeNotifications';

export function RealtimeNotificationsBridge(): null {
  useRealtimeNotifications();
  return null;
}
