import { useMemo } from 'react';
import type { HydratedPost } from '@mention/shared-types';
import { useDrafts, type Draft } from '@/hooks/useDrafts';
import { useServerDrafts } from '@/hooks/useServerDrafts';

/**
 * One row of the drafts screen, from either place a draft can live.
 *
 * `origin` is the only thing that differs, and it decides the ACTIONS, never the
 * look: a server draft publishes, opens in the composer's edit route and deletes
 * through the API; a device draft loads into the composer and deletes from
 * storage. `updatedAt` is epoch milliseconds for both, so the list sorts on one
 * axis.
 */
export type DraftListItem =
  | { origin: 'server'; id: string; updatedAt: number; post: HydratedPost }
  | { origin: 'device'; id: string; updatedAt: number; draft: Draft };

/** A server draft's last change, falling back to its creation, then to 0. */
function serverUpdatedAt(post: HydratedPost): number {
  const stamp = Date.parse(post.metadata?.updatedAt ?? post.metadata?.createdAt ?? '');
  return Number.isNaN(stamp) ? 0 : stamp;
}

/**
 * Both kinds of draft as ONE list, most recently changed first.
 *
 * Stable for equal times: a server draft sorts ahead of a device draft touched
 * in the same millisecond, and each half keeps its own order within a tie,
 * because a list that reshuffles between renders reads as rows jumping.
 */
export function mergeDrafts(deviceDrafts: Draft[], serverDrafts: HydratedPost[]): DraftListItem[] {
  const items: DraftListItem[] = [
    ...serverDrafts.map((post): DraftListItem => ({
      origin: 'server',
      id: post.id,
      updatedAt: serverUpdatedAt(post),
      post,
    })),
    ...deviceDrafts.map((draft): DraftListItem => ({
      origin: 'device',
      id: draft.id,
      updatedAt: draft.updatedAt,
      draft,
    })),
  ];
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.updatedAt - a.item.updatedAt || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * The drafts screen's ONE source: device drafts (`useDrafts`) and server drafts
 * (`useServerDrafts`) merged behind a single hook.
 *
 * The seam is here on purpose. Drafts are moving to the server entirely — the
 * composer will save to it and existing device drafts will be migrated once —
 * and when that lands, the device half is deleted from this hook and nothing
 * that renders the list has to change.
 *
 * The list waits only for the DEVICE read, which is local and fast. A slow or
 * failing server read must not hide drafts that are already on the phone, so it
 * reports its own state (`serverLoading`, `serverError`) for the list to show
 * beside the rows it has.
 */
export function useDraftsList() {
  const {
    drafts: deviceDrafts,
    isLoading: deviceLoading,
    deleteDraft,
    loadDrafts,
  } = useDrafts();
  const {
    serverDrafts,
    isLoading: serverLoading,
    isError: serverError,
    refetch: refetchServerDrafts,
    publishServerDraft,
    deleteServerDraft,
    viewerId,
  } = useServerDrafts();

  const items = useMemo(
    () => mergeDrafts(deviceDrafts, serverDrafts),
    [deviceDrafts, serverDrafts],
  );

  return {
    items,
    isLoading: deviceLoading,
    serverLoading,
    serverError,
    refetchServerDrafts,
    publishServerDraft,
    deleteServerDraft,
    /** Delete a device draft, then re-read storage so the row goes. */
    deleteDeviceDraft: async (draftId: string) => {
      await deleteDraft(draftId);
      await loadDrafts();
    },
    viewerId,
  };
}
