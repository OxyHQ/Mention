// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Keeps the PUBLIC realtime socket connected for every visitor.
 *
 * Deliberately ungated: no `useAuth`, no session check, no dependency that can
 * change. `RealtimePostsBridge` is the authenticated counterpart and is torn
 * down on every sign-in/sign-out; this one must not be, because the surfaces it
 * feeds (the trends widget, `/explore/trending`) are the ones a signed-out
 * reader sees.
 */

import { useEffect } from 'react';
import { publicRealtimeService } from '@/services/publicRealtimeService';

export function PublicRealtimeBridge() {
  useEffect(() => {
    publicRealtimeService.connect();
    return () => publicRealtimeService.disconnect();
  }, []);
  return null;
}
