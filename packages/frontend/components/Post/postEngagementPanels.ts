import { create } from 'zustand';
import type { Href } from '@/lib/navigation/router';
import type { PostPanelKind } from './postEngagementContext';

export interface PostEngagementDestination {
  postId: string;
  kind: PostPanelKind;
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
  close: (viewer: string, generation: number, hostId: string, route?: string) => void;
  completeClose: (
    viewer: string,
    generation: number,
    hostId: string,
    destination: PostEngagementDestination,
  ) => void;
  retainHosts: (viewer: string, generation: number, hostIds: readonly string[]) => void;
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
  close: (viewer, generation, hostId, route) =>
    set((state) => {
      const panel = state.panels[hostId];
      if (
        state.viewer !== viewer ||
        state.generation !== generation ||
        !panel?.isOpen ||
        (route !== undefined && panel.destination.route !== route)
      )
        return state;
      // Keep outgoing content only until Bloom reports completion of its exit.
      return { panels: { ...state.panels, [hostId]: { ...panel, isOpen: false } } };
    }),
  completeClose: (viewer, generation, hostId, destination) =>
    set((state) => {
      const panel = state.panels[hostId];
      if (
        state.viewer !== viewer ||
        state.generation !== generation ||
        panel?.isOpen ||
        panel?.destination !== destination
      )
        return state;
      const panels = { ...state.panels };
      delete panels[hostId];
      return { panels };
    }),
  retainHosts: (viewer, generation, hostIds) =>
    set((state) => {
      if (state.viewer !== viewer || state.generation !== generation) return state;
      const active = new Set(hostIds);
      const panels = Object.fromEntries(
        Object.entries(state.panels).filter(([id]) => active.has(id)),
      );
      return Object.keys(panels).length === Object.keys(state.panels).length ? state : { panels };
    }),
}));
