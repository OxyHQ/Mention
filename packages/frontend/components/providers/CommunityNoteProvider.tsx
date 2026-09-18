import React, { type ReactNode } from 'react';
import { CommunityNoteHandlersContextProvider } from '@/context/CommunityNoteHandlersContext';
import { useCommunityNoteHandlers } from '@/hooks/useCommunityNotes';

/**
 * Resolves the community-note handlers once for the whole app shell.
 *
 * This is the only place the session is consulted about notes. Everything below
 * — every post row, every sheet — reads the answer out of the context, so the
 * "can a note be written here" question is asked once per viewer rather than
 * once per rendered row.
 */
export function CommunityNoteProvider({ children }: { children: ReactNode }) {
  const handlers = useCommunityNoteHandlers();
  return <CommunityNoteHandlersContextProvider handlers={handlers}>{children}</CommunityNoteHandlersContextProvider>;
}
