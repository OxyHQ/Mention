import { createContext, useContext } from 'react';
import { useAppShellPanel } from '@oxy.so/bloom/app-shell';

/**
 * Whether a post in the main panel owns the compact navigation: its reply
 * prompt replaces the app's bar, with the tabs docked beside it (a signed-in
 * reader outside the Deck). The shell provides it around the main panel's
 * navigator; only a post's screen reads it.
 */
export const PostReplyNavigationContext = createContext(false);

/** Whether this post's screen replaces the app's bar with its own. */
export function usePostOwnsNavigation(): boolean {
  const owns = useContext(PostReplyNavigationContext);
  const panel = useAppShellPanel();
  return owns && panel.id === 'main';
}
