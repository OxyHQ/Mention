import { useCallback, useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { logger } from '@oxy.so/core/logger';
import type { CommunityNoteRating } from '@mention/shared-types';
import type { CommunityNoteWriteHandlers } from '@/components/CommunityNotes/useCommunityNoteSheets';
import type { CommunityNoteDraft } from '@/components/CommunityNotes/WriteNoteSheet';
import {
  communityNotesService,
  type CommunityNoteEntryPayload,
  type CommunityNoteReason,
} from '@/services/communityNotesService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * The community-note flows, wired to the server.
 *
 * The sheets collect what a reader chose and hand it here; this is what sends
 * it. They offer a flow only when a handler exists for it, so a deployment with
 * CrowdSource switched off never shows "Add community note" at all — the
 * alternative being a form whose submission goes nowhere.
 */

/** How long the "can notes be written here" answer stays fresh. It changes with a deploy. */
const AVAILABILITY_STALE_TIME_MS = 10 * 60_000;
/** The hub's lists: short, because rating one moves it between two of them. */
const HUB_STALE_TIME_MS = 30_000;

/** Whether this deployment takes community notes, for this viewer. */
export function useCommunityNotesAvailable(): boolean {
  const { user, isAuthenticated, canUsePrivateApi } = useAuth();
  const viewerId = user?.id;

  const { data } = useQuery<boolean>({
    queryKey: viewerQueryKeys.communityNotesAvailability(viewerId),
    queryFn: async () => {
      try {
        return await communityNotesService.availability();
      } catch (error: unknown) {
        // Unreachable is indistinguishable from switched off, and both mean the
        // same thing to a reader: do not offer to write a note.
        logger.warn('Community notes availability check failed', { error });
        return false;
      }
    },
    enabled: isAuthenticated && Boolean(viewerId) && canUsePrivateApi,
    staleTime: AVAILABILITY_STALE_TIME_MS,
  });

  return data === true;
}

/**
 * The write handlers the sheets need, or an empty object when notes are off.
 *
 * Empty rather than throwing handlers: `useCommunityNoteSheets` reads their
 * PRESENCE as permission to offer the flow, so "no handler" is how the feature
 * stays invisible where it does not work.
 */
export function useCommunityNoteHandlers(): CommunityNoteWriteHandlers {
  const available = useCommunityNotesAvailable();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const viewerId = user?.id;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: viewerQueryKeys.communityNotesRoot(viewerId) });
  }, [queryClient, viewerId]);

  const submitNote = useCallback(
    async (postId: string, draft: CommunityNoteDraft) => {
      const sourceUrl = draft.sourceUrl.trim();
      await communityNotesService.write({
        postId,
        text: draft.text.trim(),
        sourceUrls: sourceUrl ? [sourceUrl] : [],
      });
      invalidate();
    },
    [invalidate],
  );

  const rateNote = useCallback(
    async (noteId: string, rating: CommunityNoteRating, reasons: string[]) => {
      await communityNotesService.rate(noteId, rating, reasons as CommunityNoteReason[]);
      invalidate();
    },
    [invalidate],
  );

  return useMemo(
    () => (available ? { submitNote, rateNote } : {}),
    [available, submitNote, rateNote],
  );
}

export interface CommunityNotesHub {
  toRate: CommunityNoteEntryPayload[];
  rated: CommunityNoteEntryPayload[];
  written: CommunityNoteEntryPayload[];
  isPending: boolean;
  handlers: CommunityNoteWriteHandlers;
}

/**
 * The three lists the hub renders.
 *
 * The queue is fetched with a POST, because asking for it is what ISSUES the
 * assignments that make rating possible — so it is a mutation the screen runs
 * once on mount rather than a query React Query may refetch on a window focus.
 * The server keys the draw per hour, so a reopened hub re-reads the same queue
 * instead of consuming a fresh one.
 */
export function useCommunityNotesHub(): CommunityNotesHub {
  const { user, isAuthenticated, canUsePrivateApi } = useAuth();
  const viewerId = user?.id;
  const available = useCommunityNotesAvailable();
  const handlers = useCommunityNoteHandlers();
  const enabled = isAuthenticated && Boolean(viewerId) && canUsePrivateApi && available;

  const queue = useMutation<CommunityNoteEntryPayload[]>({
    mutationKey: viewerQueryKeys.communityNotesQueue(viewerId),
    mutationFn: () => communityNotesService.toRate(),
  });

  const written = useQuery<CommunityNoteEntryPayload[]>({
    queryKey: viewerQueryKeys.communityNotesWritten(viewerId),
    queryFn: () => communityNotesService.mine(),
    enabled,
    staleTime: HUB_STALE_TIME_MS,
  });

  const rated = useQuery<CommunityNoteEntryPayload[]>({
    queryKey: viewerQueryKeys.communityNotesRated(viewerId),
    queryFn: () => communityNotesService.rated(),
    enabled,
    staleTime: HUB_STALE_TIME_MS,
  });

  const { mutate: drawQueue, isIdle } = queue;
  useEffect(() => {
    // Once per mount, and only when the hub is actually usable. Not a query,
    // because a refetch on window focus would be a second draw.
    if (enabled && isIdle) drawQueue();
  }, [enabled, isIdle, drawQueue]);

  return {
    toRate: queue.data ?? [],
    rated: rated.data ?? [],
    written: written.data ?? [],
    // `isLoading` rather than `isPending` for the two queries: a disabled query
    // stays pending forever, which would leave the hub spinning for a viewer it
    // will never fetch for.
    isPending: queue.isPending || written.isLoading || rated.isLoading,
    handlers,
  };
}
