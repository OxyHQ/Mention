// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useEffect, type ReactNode } from 'react';
import { usePathname } from 'expo-router';
import { useDeckHome } from './useDeckHome';
import { useDeckSettings } from './deckSettings';

/** Mount only at the root shell; panel routes must never inherit this policy. */
export function DeckHomeEntry({ children }: { children: ReactNode }) {
  const deckHome = useDeckHome();
  const pathname = usePathname();
  useEffect(() => {
    if (pathname === '/' && deckHome) useDeckSettings.getState().setDeckEnabled(true);
  }, [pathname, deckHome]);
  return children;
}
