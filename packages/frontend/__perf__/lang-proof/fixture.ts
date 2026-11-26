/**
 * DEV ONLY. The deterministic world the notification-settings screen is
 * measured in, for the Bloom language proof (`__perf__/lang-proof/README.md`).
 *
 * The screen reads three app hooks: `useAuth` (signed in? still resolving?),
 * `useViewerSettingsSection` (the stored preferences and their `update`) and
 * `useSettingsRouter`. The Jest harness (`jest.mock`) and the web proof app
 * (`metro.config.js`, `BLOOM_LANG_PROOF=1`, scoped to the screen's own files)
 * both replace those three with the stand-ins below, so the TypeScript screen
 * and its `.bloom` port read exactly the same state. Nothing in the production
 * app imports this file.
 */
import { useSyncExternalStore } from 'react';

export type ProofBranch = 'pending' | 'signedOut' | 'loading' | 'loaded';

export interface StoredNotificationPreferences {
  pushEnabled?: boolean;
  likes?: boolean;
  boosts?: boolean;
  follows?: boolean;
  mentions?: boolean;
  replies?: boolean;
  quotes?: boolean;
}

interface ProofState {
  branch: ProofBranch;
  stored: StoredNotificationPreferences;
}

/** What a signed-in viewer has stored: two preferences off, the rest defaulted. */
export const STORED_PREFERENCES: StoredNotificationPreferences = Object.freeze({
  boosts: false,
  quotes: false,
});

let state: ProofState = { branch: 'loaded', stored: STORED_PREFERENCES };
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const read = () => state;

/** Puts the world in a branch, with the stored preferences reset. */
export function setProofBranch(branch: ProofBranch): void {
  state = { branch, stored: STORED_PREFERENCES };
  emit();
}

/**
 * How a save ends. `resolve` by default; the Jest harness holds each save open
 * (`hold`) so it can time the `saving` render and the settle render apart.
 */
type SaveMode = 'resolve' | 'reject' | 'hold';
let saveMode: SaveMode = 'resolve';
let pendingSave: { resolve: () => void; reject: (error: Error) => void } | null = null;

export function setSaveMode(mode: SaveMode): void {
  saveMode = mode;
}

/** Ends the save `hold` kept open. */
export function settleSave(outcome: 'resolve' | 'reject' = 'resolve'): void {
  const save = pendingSave;
  pendingSave = null;
  if (!save) throw new Error('No save is open');
  if (outcome === 'resolve') save.resolve();
  else save.reject(new Error('proof: save failed'));
}

/** Every patch `update` was handed, oldest first (the harness asserts on it). */
export const savedPatches: StoredNotificationPreferences[] = [];

/** `update` as the real hook behaves: paints the patch at once, then saves. */
async function update(patch: StoredNotificationPreferences): Promise<void> {
  savedPatches.push(patch);
  state = { ...state, stored: { ...state.stored, ...patch } };
  emit();
  if (saveMode === 'resolve') return;
  if (saveMode === 'reject') throw new Error('proof: save failed');
  await new Promise<void>((resolve, reject) => {
    pendingSave = { resolve, reject };
  });
}

// ── The stand-ins ────────────────────────────────────────────────

/** `useAuth()` from `@oxy.so/services/ui/client`, the two fields the screen reads. */
export function useProofAuth() {
  const { branch } = useSyncExternalStore(subscribe, read, read);
  return {
    isPrivateApiPending: branch === 'pending',
    canUsePrivateApi: branch === 'loading' || branch === 'loaded',
  };
}

/** `useViewerSettingsSection('notificationPreferences')` from `@/hooks/useViewerSettings`. */
export function useProofViewerSettingsSection(_section: 'notificationPreferences') {
  const { branch, stored } = useSyncExternalStore(subscribe, read, read);
  return { value: stored, isLoading: branch === 'loading', update };
}

/** The navigations the screen asked for, oldest first. */
export const navigations: string[] = [];
const proofRouter = {
  push: (path: string) => {
    navigations.push(path);
  },
  replace: (path: string) => {
    navigations.push(path);
  },
  navigate: (path: string) => {
    navigations.push(path);
  },
  back: () => undefined,
  canGoBack: () => true,
};

/** `useSettingsRouter()` from `@/context/MentionSettingsContext`. */
export function useProofSettingsRouter() {
  return proofRouter;
}
