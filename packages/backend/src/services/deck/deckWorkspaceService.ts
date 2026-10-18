import type { DeckWorkspaceUpdate } from '@mention/shared-types/deck';
import {
  compareAndSwapDeckWorkspace,
  loadDeckWorkspace as loadStoredDeckWorkspace,
  type DeckWorkspaceWrite,
} from '../../db/deck/deckWorkspaceRepository';

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
