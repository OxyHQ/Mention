import React, { createContext, useContext, type ReactNode } from 'react';
import type { CommunityNoteWriteHandlers } from '@/components/CommunityNotes/useCommunityNoteSheets';

/**
 * Who can receive a community note, made available to every post row.
 *
 * A row does not fetch this for itself, for two reasons and both of them are
 * load-bearing:
 *
 *   * A feed page mounts a hundred rows. Whether this deployment takes notes is
 *     one answer for the whole app, and a hundred subscriptions to it is ninety-
 *     nine more than the question has.
 *   * `PostItem` deliberately imports nothing that reaches the Oxy session SDK
 *     — it reads the viewer's relationship to a post off the post itself. The
 *     handlers need the session, so they are resolved ONCE, up in the provider
 *     tree, and handed down as data.
 *
 * The default is `{}`: no handler, therefore no flow offered. A tree that never
 * mounts the provider — a test rendering one row, a surface that does not want
 * the feature — simply has no "Add community note" entry, which is the correct
 * reading of "nothing here can receive one".
 */
const CommunityNoteHandlersContext = createContext<CommunityNoteWriteHandlers>({});

export function useCommunityNoteHandlerContext(): CommunityNoteWriteHandlers {
  return useContext(CommunityNoteHandlersContext);
}

export function CommunityNoteHandlersContextProvider({
  handlers,
  children,
}: {
  handlers: CommunityNoteWriteHandlers;
  children: ReactNode;
}) {
  return (
    <CommunityNoteHandlersContext.Provider value={handlers}>{children}</CommunityNoteHandlersContext.Provider>
  );
}
