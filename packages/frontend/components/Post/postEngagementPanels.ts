import { create } from 'zustand';
import type { Href } from '@/lib/navigation/router';

export interface PostEngagementDestination {
  postId: string;
  kind: 'likes' | 'boosts';
  route: string;
  navigate: (href: Href) => void;
}

export interface PostEngagementPanel {
  destination: PostEngagementDestination;
  isOpen: boolean;
}

interface PostEngagementPanelsState {
  viewer: string | null;
  generation: number;
  panels: Readonly<Record<string, PostEngagementPanel | undefined>>;
  activate: (viewer: string) => void;
  open: (
    viewer: string,
    generation: number,
    hostId: string,
    destination: PostEngagementDestination,
  ) => void;
  close: (viewer: string, generation: number, hostId: string) => void;
  release: (viewer: string, generation: number, hostId: string, route: string) => void;
}

/** Transient panel intent; never persisted with Deck or shared between accounts. */
export const usePostEngagementPanels = create<PostEngagementPanelsState>((set) => ({
  viewer: null,
  generation: 0,
  panels: {},
  activate: (viewer) =>
    set((state) =>
      state.viewer === viewer
        ? state
        : {
            viewer,
            generation: state.generation + 1,
            panels: {},
          },
    ),
  open: (viewer, generation, hostId, destination) =>
    set((state) =>
      state.viewer !== viewer || state.generation !== generation
        ? state
        : {
            panels: { ...state.panels, [hostId]: { destination, isOpen: true } },
          },
    ),
  close: (viewer, generation, hostId) =>
    set((state) => {
      const panel = state.panels[hostId];
      if (state.viewer !== viewer || state.generation !== generation || !panel?.isOpen)
        return state;
      // Retain the destination during Bloom's exit transition. The compositor owns unmounting.
      return { panels: { ...state.panels, [hostId]: { ...panel, isOpen: false } } };
    }),
  release: (viewer, generation, hostId, route) =>
    set((state) => {
      const panel = state.panels[hostId];
      if (
        state.viewer !== viewer ||
        state.generation !== generation ||
        panel?.destination.route !== route
      )
        return state;
      // Route departure/removal has no supporting content to retain. Release its navigation closure too.
      const panels = { ...state.panels };
      delete panels[hostId];
      return { panels };
    }),
}));
