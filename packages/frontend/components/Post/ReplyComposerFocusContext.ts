import { createContext } from 'react';

/** The containing footer and its one editor share interaction state, never geometry. */
export const ReplyComposerFocusContext = createContext<{
  focused: boolean;
  setFocused: (focused: boolean) => void;
} | null>(null);
