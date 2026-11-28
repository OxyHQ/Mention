// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { DeckWorkspaceUpdate } from '@mention/shared-types/deck';
import {
  compareAndSwapDeckWorkspace,
  loadDeckWorkspace as loadStoredDeckWorkspace,
  type DeckWorkspaceWrite,
} from '../../../db/deck/deckWorkspaceRepository';

export function loadDeckWorkspace(oxyUserId: string) {
  return loadStoredDeckWorkspace(oxyUserId);
}

/** The account's sync preference decides which device state may reach storage. */
export function saveDeckWorkspace(oxyUserId: string, update: DeckWorkspaceUpdate) {
  const write: DeckWorkspaceWrite = update.state.syncEnabled
    ? { kind: 'replace', state: update.state }
    : {
        kind: 'sync-preference',
        syncEnabled: false,
        // An opt-out before the first sync must not upload local panels/history.
        initialState: { syncEnabled: false, panels: {}, order: [] },
      };
  return compareAndSwapDeckWorkspace(oxyUserId, update.baseRevision, write);
}
