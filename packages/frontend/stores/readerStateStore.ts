import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import type { FeedInterstitialKind } from '@mention/shared-types';

/**
 * What the reader did to things on screen this session — a post they
 * translated, a content warning they opened, a sensitive image they revealed, a
 * long post they expanded, a notification group they opened, a suggestion card
 * they dismissed.
 *
 * WHY THIS IS NOT COMPONENT STATE. Every surface that shows these things is a
 * virtualized list. Native feeds are FlashList, which RECYCLES a cell: the same
 * component instance is handed a different post, so a `useState` there either
 * leaks into that other post or — stamped with the id it was made for — is
 * simply ignored. The web feed unmounts a row that leaves the window, so its
 * state is gone. Either way a reader who translated a post, scrolled on and
 * came back found it in the original language again. The answer belongs to the
 * POST (or notification, or card), not to whichever row happens to draw it, so
 * it lives here, keyed by that id, and outlives every row.
 *
 * Per post rather than per row also means the same post reads the same
 * everywhere it appears — the feed, a quote of it, its detail screen.
 *
 * In memory for the session and nothing more: a machine translation the reader
 * asked for is cached server-side and served on the next hydration anyway.
 * Translations and flags are bounded, oldest first; all of it is cleared on an
 * account switch.
 */

/** The reader's override of the rendition the server served for one post. */
export interface PostTranslationState {
  /** The language the reader picked; `null` is the server's own choice. */
  selectedTag: string | null;
  /** Machine bodies fetched this session, keyed by their canonical tag. */
  fetchedBodies: Readonly<Record<string, string>>;
  isTranslating: boolean;
}

interface ReaderState {
  /** Per post: the one answer that is data rather than on/off. */
  translations: ReadonlyMap<string, PostTranslationState>;
  /** Every on/off answer, by a {@link readerKeys} key. */
  flags: ReadonlyMap<string, true>;
  /**
   * Suggestion cards the reader dismissed, per interstitial band kind — a set,
   * because a band filters its whole pool by it. Grows only by hand, one tap
   * per card, so it is not capped.
   */
  dismissedInterstitialItems: ReadonlyMap<FeedInterstitialKind, ReadonlySet<string>>;
}

/** Enough for a long session of scrolling; each entry is a few small fields. */
export const MAX_READER_ENTRIES = 1_000;

export const NO_TRANSLATION: PostTranslationState = Object.freeze({
  selectedTag: null,
  fetchedBodies: Object.freeze({}),
  isTranslating: false,
});

/**
 * Every flag key, built in one place so no two features can collide and no
 * caller hand-writes a key string. A post key with no post id yet is
 * `undefined`, which reads off and writes nothing.
 */
export const readerKeys = {
  contentWarning: (postId: string | undefined) => postId && `content-warning:${postId}`,
  postText: (postId: string | undefined) => postId && `post-text:${postId}`,
  /** One sensitive media item of a post; revealing one never reveals the rest. */
  media: (postId: string | undefined, mediaKey: string) => postId && `media:${postId}:${mediaKey}`,
  notificationGroup: (id: string) => `notification-group:${id}`,
  communityNote: (id: string) => `community-note:${id}`,
} as const;

/**
 * Bumped on every reset. An async write (a translation landing) captures it at
 * the start and is dropped if the viewer changed in between.
 */
let readerEpoch = 0;

const emptyReaderState = (): ReaderState => ({
  translations: new Map(),
  flags: new Map(),
  dismissedInterstitialItems: new Map(),
});

const NO_DISMISSED_ITEMS: ReadonlySet<string> = new Set();

export const useReaderStateStore = create<ReaderState>(emptyReaderState);

/** Re-insert `key` as the newest entry and evict the oldest past the cap. */
function withEntry<V>(
  map: ReadonlyMap<string, V>,
  key: string,
  value: V | undefined,
): Map<string, V> {
  const next = new Map(map);
  next.delete(key);
  if (value !== undefined) next.set(key, value);
  while (next.size > MAX_READER_ENTRIES) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

export function currentReaderEpoch(): number {
  return readerEpoch;
}

/**
 * Merge into one post's translation override; a row with no post id yet writes
 * nothing. `epoch`, when given, is the {@link currentReaderEpoch} the write was
 * started under — a write from a previous viewer is dropped.
 */
export function patchPostTranslation(
  postId: string | undefined,
  patch: (translation: PostTranslationState) => Partial<PostTranslationState>,
  epoch?: number,
): void {
  if (!postId || (epoch !== undefined && epoch !== readerEpoch)) return;
  useReaderStateStore.setState((state) => {
    const translation = state.translations.get(postId) ?? NO_TRANSLATION;
    return {
      translations: withEntry(state.translations, postId, {
        ...translation,
        ...patch(translation),
      }),
    };
  });
}

export function setReaderFlag(key: string | undefined, on: boolean): void {
  if (!key) return;
  useReaderStateStore.setState((state) => ({
    flags: withEntry(state.flags, key, on ? true : undefined),
  }));
}

/** Flip one flag; an undefined key writes nothing. */
export function toggleReaderFlag(key: string | undefined): void {
  setReaderFlag(key, !(key && useReaderStateStore.getState().flags.has(key)));
}

export function resetReaderState(): void {
  readerEpoch += 1;
  useReaderStateStore.setState(emptyReaderState());
}

/**
 * A read of the store in ONE hook slot. Zustand's own hook adds a
 * `useDebugValue` slot to every call, and these reads sit in feed rows, whose
 * hook count is a gated budget (`Feed/__perf__/budgets.json`). `select` returns
 * a primitive or an object held in the state, so the snapshot is stable.
 */
function useReaderSelect<T>(select: (state: ReaderState) => T): T {
  const getSnapshot = () => select(useReaderStateStore.getState());
  return useSyncExternalStore(useReaderStateStore.subscribe, getSnapshot, getSnapshot);
}

/** One post's translation override, or {@link NO_TRANSLATION}. */
export function usePostTranslation(postId: string | undefined): PostTranslationState {
  return useReaderSelect(
    (state) => (postId ? state.translations.get(postId) : undefined) ?? NO_TRANSLATION,
  );
}

/** Whether one flag is on; an undefined key reads off. Toggle with {@link toggleReaderFlag}. */
export function useReaderFlag(key: string | undefined): boolean {
  return useReaderSelect((state) => (key ? state.flags.has(key) : false));
}

/**
 * The cards of one interstitial band kind the reader dismissed. Held by the
 * kind, not the band: a band is a feed row, recycled or unmounted on scroll,
 * and a band-held set brought every dismissed card back when the reader
 * scrolled away and returned.
 */
export function useDismissedInterstitialItems(kind: FeedInterstitialKind): ReadonlySet<string> {
  return useReaderSelect(
    (state) => state.dismissedInterstitialItems.get(kind) ?? NO_DISMISSED_ITEMS,
  );
}

export function dismissInterstitialItem(kind: FeedInterstitialKind, itemId: string): void {
  useReaderStateStore.setState((state) => {
    const next = new Map(state.dismissedInterstitialItems);
    next.set(kind, new Set(next.get(kind)).add(itemId));
    return { dismissedInterstitialItems: next };
  });
}
