/** Private UI state only: references, navigation and geometry, never fetched content. */
export const DECK_SOURCES = ['explore', 'trending', 'following', 'saved'] as const;
export type DeckSource = (typeof DECK_SOURCES)[number];
export type DeckRouteParam = string | string[] | number | boolean | null;
export interface DeckRoute {
  key: string;
  name: string;
  params?: Record<string, DeckRouteParam>;
}
export interface DeckPanelState {
  source: DeckSource;
  width: number;
  resizable: boolean;
  appearance: 'solid' | 'plain';
  colorPreset?: string;
  liveUpdates?: boolean;
  pauseWhileReading?: boolean;
  navigation?: { entries: DeckRoute[]; index: number };
  scrollOffsets?: Record<string, number>;
}
export interface DeckWorkspaceState {
  /** Desktop web only; omitted by older clients and defaults to false. */
  homeScreen?: boolean;
  syncEnabled: boolean;
  panels: Record<string, DeckPanelState>;
  order: string[];
  activePanel?: string;
}
export interface DeckWorkspaceResponse {
  revision: number;
  state: DeckWorkspaceState | null;
}
/** A 409 returns DeckWorkspaceResponse with the latest server revision/state. */
export interface DeckWorkspaceUpdate {
  baseRevision: number;
  state: DeckWorkspaceState;
}
export const DECK_LIMITS = {
  panels: 24,
  historyEntries: 100,
  scrollOffsets: 256,
  payloadBytes: 524_288,
} as const;
