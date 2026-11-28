// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * RealtimePostsBridge Component
 * Extracted from _layout.tsx for better organization
 * Keeps posts socket connected (mounted under OxyProvider)
 */

import useRealtimePosts from '@/hooks/useRealtimePosts';

/**
 * Bridge component that enables realtime posts functionality
 * Must be rendered under OxyProvider to access useAuth
 */
export function RealtimePostsBridge() {
  useRealtimePosts();
  return null;
}
