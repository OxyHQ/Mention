import { deckEqual } from './deckPersistence';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { PanelNavigationState, PanelRevealRequest } from '@oxy.so/bloom/app-shell';
import type { AppColorName } from '@oxy.so/bloom/theme';
import {
  DECK_SOURCES,
  DECK_LIMITS,
  type DeckSource,
  type DeckPanelState,
  type DeckWorkspaceState,
} from '@mention/shared-types/deck';
export { DECK_SOURCES, type DeckSource } from '@mention/shared-types/deck';
import { normalizeDeckSnapshot, normalizeNavigation, boundDeckSnapshot } from './deckValidation';

export function deckRouteForSource(source: DeckSource) {
  return source === 'saved' || source === 'explore'
    ? { name: `/${source}` }
    : { name: `/feeds/view?descriptor=${source}` };
}
export type DeckPanelSettings = Omit<DeckPanelState, 'colorPreset'> & {
  colorPreset?: AppColorName;
};
export const DEFAULT_DECK_SETTINGS: Record<string, DeckPanelSettings> = Object.fromEntries(
  DECK_SOURCES.map((source, index) => [
    `deck-${index}`,
    { source, width: 390, resizable: true, appearance: 'solid' },
  ]),
);
export interface DeckSnapshot extends DeckWorkspaceState {
  panels: Record<string, DeckPanelSettings>;
}
export interface DeckCache {
  state: DeckSnapshot;
  base: DeckSnapshot | null;
  revision: number;
  dirty: boolean;
}
export const emptySnapshot = (): DeckSnapshot => ({
  syncEnabled: true,
  panels: structuredClone(DEFAULT_DECK_SETTINGS),
  order: Object.keys(DEFAULT_DECK_SETTINGS),
});
function legacyAnonymousCache(): DeckCache | undefined {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem('mention:deck:panels');
    if (!raw || raw.length > DECK_LIMITS.payloadBytes) return;
    const legacy = JSON.parse(raw)?.state?.panels;
    if (!legacy || typeof legacy !== 'object') return;
    const state = normalizeDeckSnapshot({
      syncEnabled: true,
      panels: legacy,
      order: Object.keys(legacy),
    });
    if (state) return { state, base: null, revision: 0, dirty: true };
  } catch {
    /* An unreadable legacy cache must not prevent opening Deck. */
  }
}
const emptyCache = (): DeckCache => ({
  state: emptySnapshot(),
  base: null,
  revision: 0,
  dirty: false,
});
export type DeckSyncStatus = 'local' | 'loading' | 'saving' | 'saved' | 'error';
interface DeckSettingsState extends DeckSnapshot {
  viewer: string;
  records: Record<string, DeckCache>;
  status: DeckSyncStatus;
  restorationEpoch: number;
  /** Explicit local actions only; never part of DeckSnapshot or persisted records. */
  revealPanel?: PanelRevealRequest;
  restoreScope(): void;
  activate(viewer: string): void;
  receive(viewer: string, cache: DeckCache): void;
  setStatus(viewer: string, status: DeckSyncStatus): void;
  setSyncEnabled(enabled: boolean): void;
  setHomeScreen(enabled: boolean): void;
  removePanel(id: string): void;
  addPanel(source: DeckSource): string;
  updatePanel(
    id: string,
    changes: Partial<Omit<DeckPanelSettings, 'navigation'>> & { navigation?: PanelNavigationState },
  ): void;
  resetPanel(id: string): void;
}
/** Instant, account-isolated cache. Only acknowledged snapshots clear dirty. */
export const useDeckSettings = create<DeckSettingsState>()(
  persist(
    (set) => {
      const edit = (change: (state: DeckSnapshot) => DeckSnapshot) =>
        set((store) => {
          const state = boundDeckSnapshot(
            change({
              panels: store.panels,
              activePanel: store.activePanel,
              syncEnabled: store.syncEnabled,
              homeScreen: store.homeScreen,
              order: store.order,
            }),
          );
          const previous = store.records[store.viewer] ?? emptyCache();
          if (deckEqual(state, previous.state)) return store;
          return {
            ...state,
            records: { ...store.records, [store.viewer]: { ...previous, state, dirty: true } },
          };
        });
      return {
        ...emptySnapshot(),
        homeScreen: undefined,
        viewer: 'anonymous',
        records: {},
        status: 'local',
        restorationEpoch: 0,
        restoreScope: () => set((state) => ({ restorationEpoch: state.restorationEpoch + 1 })),
        activate: (viewer) =>
          set((store) => {
            const cache =
              store.records[viewer] ??
              (viewer === 'anonymous' ? legacyAnonymousCache() : undefined) ??
              emptyCache();
            return {
              ...cache.state,
              homeScreen: cache.state.homeScreen,
              viewer,
              revealPanel: undefined,
              status: viewer === 'anonymous' ? 'local' : 'loading',
              records: { ...store.records, [viewer]: cache },
            };
          }),
        receive: (viewer, cache) =>
          set((store) =>
            store.viewer !== viewer
              ? store
              : {
                  ...cache.state,
                  homeScreen: cache.state.homeScreen,
                  records: { ...store.records, [viewer]: cache },
                },
          ),
        setStatus: (viewer, status) =>
          set((store) => (store.viewer === viewer ? { status } : store)),
        setHomeScreen: (homeScreen) => edit((state) => ({ ...state, homeScreen })),
        setSyncEnabled: (syncEnabled) => edit((state) => ({ ...state, syncEnabled })),
        removePanel: (id) =>
          edit((state) => {
            if (Object.keys(state.panels).length <= 1) return state;
            const panels = { ...state.panels };
            delete panels[id];
            return {
              ...state,
              panels,
              order: state.order.filter((key) => key !== id),
              activePanel: state.activePanel === id ? Object.keys(panels)[0] : state.activePanel,
            };
          }),
        addPanel: (source) => {
          const id = `deck-${globalThis.crypto.randomUUID()}`;
          edit((state) =>
            Object.keys(state.panels).length >= DECK_LIMITS.panels
              ? state
              : {
                  ...state,
                  activePanel: id,
                  order: [...state.order, id],
                  panels: {
                    ...state.panels,
                    [id]: { source, width: 390, resizable: true, appearance: 'solid' },
                  },
                },
          );
          set((store) =>
            store.panels[id]
              ? { revealPanel: { id, requestKey: globalThis.crypto.randomUUID() } }
              : store,
          );
          return id;
        },
        updatePanel: (id, changes) =>
          edit((state) => {
            const current = state.panels[id];
            if (!current) return state;
            const navigation = changes.navigation
              ? normalizeNavigation(changes.navigation)
              : undefined;
            return {
              ...state,
              panels: {
                ...state.panels,
                [id]: {
                  ...current,
                  ...changes,
                  navigation: navigation ?? current.navigation,
                  ...(navigation ? { navigation } : {}),
                  width: Math.max(300, Math.min(620, changes.width ?? current.width)),
                },
              },
            };
          }),
        resetPanel: (id) =>
          edit((state) =>
            !state.panels[id]
              ? state
              : {
                  ...state,
                  panels: {
                    ...state.panels,
                    [id]: { ...(DEFAULT_DECK_SETTINGS[id] ?? DEFAULT_DECK_SETTINGS['deck-0']) },
                  },
                },
          ),
      };
    },
    {
      name: 'mention:deck:workspace',
      version: 1,
      storage: createJSONStorage(() =>
        typeof localStorage === 'undefined'
          ? { getItem: () => null, setItem: () => {}, removeItem: () => {} }
          : localStorage,
      ),
      merge: (persisted, current) => {
        const records: Record<string, DeckCache> = {};
        const source = (persisted as { records?: Record<string, DeckCache> })?.records;
        for (const [viewer, cache] of Object.entries(source ?? {})) {
          if (!cache || typeof cache !== 'object') continue;
          const state = normalizeDeckSnapshot(cache.state);
          if (!state) continue;
          records[viewer] = {
            state,
            base: normalizeDeckSnapshot(cache.base),
            revision:
              Number.isSafeInteger(cache.revision) && cache.revision >= 0 ? cache.revision : 0,
            dirty: cache.dirty === true,
          };
        }
        return { ...current, records };
      },
      partialize: (state) => ({ records: state.records }),
    },
  ),
);
