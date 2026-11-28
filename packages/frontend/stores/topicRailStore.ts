import { create } from 'zustand';

/**
 * The topic the topic screen is showing, so the right rail can render that
 * topic's widgets above the shared ones.
 *
 * Only the term is shared. The widgets read their own data by term, so the rail
 * never receives a node from the screen and the screen never reaches into the
 * rail. Cleared on unmount, so a topic's widgets cannot outlive its page.
 */
interface TopicRailState {
  term: string | null;
  setTerm: (term: string | null) => void;
}

export const useTopicRailStore = create<TopicRailState>()((set) => ({
  term: null,
  setTerm: (term) => set({ term }),
}));
