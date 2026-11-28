import type { ComposerMediaItem } from '@/utils/composeUtils';
import { moveItem } from '@oxy.so/bloom/hooks';
import { createStore } from 'zustand/vanilla';

interface ReplySubmission {
  id: symbol;
  text: string;
  mediaIds: ComposerMediaItem[];
  revision: number;
}

/** Text and an in-flight send belong to a reply destination, not its presentation. */
export function createReplyDraft(isCurrent?: () => boolean) {
  const store = createStore<{
    text: string;
    mediaIds: ComposerMediaItem[];
    revision: number;
    pending: ReplySubmission | null;
    setText: (text: string) => void;
    addMedia: (items: ComposerMediaItem[]) => void;
    removeMedia: (id: string) => void;
    moveMedia: (id: string, direction: 'left' | 'right') => void;
    begin: () => ReplySubmission | null;
    clearIfUnchanged: (revision: number) => void;
    finish: (id: symbol) => void;
  }>((set, get) => ({
    text: '',
    mediaIds: [],
    revision: 0,
    pending: null,
    setText: (text) => set((state) => ({ text, revision: state.revision + 1 })),
    addMedia: (items) =>
      set((state) => {
        const ids = new Set(state.mediaIds.map((item) => item.id));
        const added = items.filter((item) => {
          if (ids.has(item.id)) return false;
          ids.add(item.id);
          return true;
        });
        return added.length
          ? {
              mediaIds: [...state.mediaIds, ...added.map((item) => ({ ...item }))],
              revision: state.revision + 1,
            }
          : state;
      }),
    removeMedia: (id) =>
      set((state) => ({
        mediaIds: state.mediaIds.filter((item) => item.id !== id),
        revision: state.revision + 1,
      })),
    moveMedia: (id, direction) =>
      set((state) => {
        const from = state.mediaIds.findIndex((item) => item.id === id);
        const to = from + (direction === 'left' ? -1 : 1);
        return from < 0 || to < 0 || to >= state.mediaIds.length
          ? state
          : { mediaIds: moveItem(state.mediaIds, from, to), revision: state.revision + 1 };
      }),
    begin: () => {
      const state = get();
      if (state.pending || (!state.text.trim() && !state.mediaIds.length)) return null;
      const pending = {
        id: Symbol('reply'),
        text: state.text.trim(),
        mediaIds: state.mediaIds.map((item) => ({ ...item })),
        revision: state.revision,
      };
      set({ pending });
      return pending;
    },
    clearIfUnchanged: (revision) =>
      set((state) =>
        state.revision === revision ? { text: '', mediaIds: [], revision: revision + 1 } : state,
      ),
    finish: (id) => set((state) => (state.pending?.id === id ? { pending: null } : state)),
  }));
  return { store, isCurrent };
}

export type ReplyDraft = ReturnType<typeof createReplyDraft>;
