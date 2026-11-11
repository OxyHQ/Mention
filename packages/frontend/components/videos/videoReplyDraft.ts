import { createStore } from 'zustand/vanilla';

interface ReplySubmission {
  id: symbol;
  text: string;
  revision: number;
}

/** Text and an in-flight send belong to a video destination, not its presentation. */
export function createVideoReplyDraft(isCurrent?: () => boolean) {
  const store = createStore<{
    text: string;
    revision: number;
    pending: ReplySubmission | null;
    setText: (text: string) => void;
    begin: () => ReplySubmission | null;
    clearIfUnchanged: (revision: number) => void;
    finish: (id: symbol) => void;
  }>((set, get) => ({
    text: '',
    revision: 0,
    pending: null,
    setText: (text) => set((state) => ({ text, revision: state.revision + 1 })),
    begin: () => {
      const state = get();
      if (state.pending || !state.text.trim()) return null;
      const pending = { id: Symbol('reply'), text: state.text.trim(), revision: state.revision };
      set({ pending });
      return pending;
    },
    clearIfUnchanged: (revision) =>
      set((state) => (state.revision === revision ? { text: '', revision: revision + 1 } : state)),
    finish: (id) => set((state) => (state.pending?.id === id ? { pending: null } : state)),
  }));
  return { store, isCurrent };
}

export type VideoReplyDraft = ReturnType<typeof createVideoReplyDraft>;
