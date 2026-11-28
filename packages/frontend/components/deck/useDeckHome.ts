// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useAuth } from '@oxy.so/services/ui/client';
import { useDeckAvailable } from './useDeckAvailable';
import { useDeckSettings } from './deckSettings';

/** Root-shell policy only: embedded Home routes always remain ordinary feeds. */
export function useDeckHome() {
  const available = useDeckAvailable();
  const { user, isAuthResolved } = useAuth();
  const viewer = user?.id ? `user:${user.id}` : 'anonymous';
  return useDeckSettings(
    (state) => available && isAuthResolved && state.viewer === viewer && state.homeScreen === true,
  );
}
