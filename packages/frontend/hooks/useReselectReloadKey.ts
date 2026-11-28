// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { type ScreenReselectHandler, useScreenReselectHandler } from '@oxy.so/bloom/screen';
import { useState } from 'react';

/**
 * For a screen whose reload is "fetch the feed again from the top": a
 * `reloadKey` for its `<Feed>` that moves each time the enclosing Screen is
 * reselected at the top. `refresh` carries whatever else reloads alongside
 * the feed. Call it from inside the `<Screen>`.
 */
export function useReselectReloadKey(refresh?: ScreenReselectHandler['refresh']): number {
  const [reloadKey, setReloadKey] = useState(0);
  useScreenReselectHandler({
    refresh: () => {
      setReloadKey((key) => key + 1);
      return refresh?.();
    },
  });
  return reloadKey;
}
