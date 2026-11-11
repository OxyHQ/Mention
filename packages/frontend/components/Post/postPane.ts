import { create } from 'zustand';

/** What a post's supporting panel shows. Data, not UI: the panel renders it. */
export type PostPaneDestination = {
  kind: 'likes' | 'boosts';
  postId: string;
};

/** The id of the panel stacked under the panel `hostId`. */
export const postPanelId = (hostId: string) => `${hostId}:pane`;

interface PostPaneState {
  /** The destination open under each panel, by the id of the panel that hosts the post. */
  destinations: Readonly<Record<string, PostPaneDestination | undefined>>;
  open: (hostId: string, destination: PostPaneDestination) => void;
  close: (hostId: string) => void;
}

export const usePostPaneStore = create<PostPaneState>((set) => ({
  destinations: {},
  open: (hostId, destination) =>
    set((state) => ({ destinations: { ...state.destinations, [hostId]: destination } })),
  close: (hostId) =>
    set((state) =>
      state.destinations[hostId] === undefined
        ? state
        : { destinations: { ...state.destinations, [hostId]: undefined } },
    ),
}));
