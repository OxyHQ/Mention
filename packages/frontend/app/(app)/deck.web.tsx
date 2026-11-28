// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { Redirect } from '@/lib/navigation/router';
import { useDeckAvailable } from '@/components/deck/useDeckAvailable';
import { useEffect } from 'react';
import { useDeckSettings } from '@/components/deck/deckSettings';

/** Bloom's root panel descriptors own the columns; Expo owns this route. */
export default function DeckScreen() {
  const available = useDeckAvailable();
  useEffect(() => {
    if (available) useDeckSettings.getState().setDeckEnabled(true);
  }, [available]);
  return <Redirect href="/" />;
}
