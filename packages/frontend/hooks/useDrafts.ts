import type { CommerceReference } from '@mention/shared-types/commerce';
import { podcastReference } from '@/utils/podcastReference';
import { useState, useEffect, useCallback } from 'react';
import { Storage } from '@/utils/storage';
import { createLogger } from '@oxy.so/core/logger';
import type { DraftVariants } from '@/utils/composeVariants';
import type { PostJobContent } from '@mention/shared-types';
import type { EventData } from './useEventManager';
import type { RoomAttachmentData } from './useRoomManager';
import { useAuth } from '@oxy.so/services/ui/client';
import { viewerStorageKey } from '@/lib/viewerQueryKeys';
import { draftMutationQueue } from '@/utils/draftMutationQueue';
import {
  createDraftId,
  draftRevision,
  DraftConflictError,
  type DraftSession,
} from '@/utils/draftSession';
import { useRefSync } from '@/hooks/useRefSync';

const logger = createLogger('useDrafts');

/**
 * What a draft stores for ONE box — the root post or a thread item. The two
 * used to be spelled out separately and drifted: thread items kept none of
 * their attachments. Fields added after the first release are optional because
 * drafts are stored raw and unversioned; an older draft simply has none.
 */
export interface DraftBox {
  mediaIds: Array<{ id: string; type: 'image' | 'video' | 'gif' }>;
  pollOptions: string[];
  pollTitle?: string;
  showPollCreator: boolean;
  location: { latitude: number; longitude: number; address?: string } | null;
  mentions: Array<{ userId: string; handle: string; name: string }>;
  sources?: Array<{ id?: string; title?: string; url?: string }>;
  article?: { title?: string; body?: string } | null;
  event?: EventData | null;
  room?: RoomAttachmentData | null;
  podcast?: { syraPodcastId: string } | null;
  commerce?: CommerceReference[];
  attachmentOrder?: string[];
}

export interface Draft extends DraftBox {
  id: string;
  postContent: string;
  /** The ROOT post's attached Mention job, if any (OxyHQ/Mention#952). Thread items don't carry one yet. */
  job?: PostJobContent | null;
  scheduledAt?: string | null;
  threadItems: Array<DraftBox & { id: string; text: string }>;
  postingMode: 'thread' | 'beast';
  /**
   * The post's declared languages and their author renditions, keyed by composer
   * item so a thread keeps a body per (item × language).
   *
   * Optional because drafts are stored raw and unversioned: a draft saved before
   * this feature existed has no `languages` key and must still open. The reader
   * (`deserializeVariants`) tolerates anything, so an old — or corrupt — draft
   * degrades to a single-language buffer instead of being lost.
   */
  languages?: DraftVariants;
  createdAt: number;
  updatedAt: number;
  /** Checked under this runtime's account queue; legacy drafts omit it. */
  localRevision?: number;
}

/**
 * A draft as a CALLER submits it. The id is optional (absent means "create") and
 * the timestamps are owned by {@link useDrafts}, never by the composer.
 */
export type DraftInput = Omit<Draft, 'id' | 'createdAt' | 'updatedAt' | 'localRevision'> & {
  id?: string;
};

const LEGACY_DRAFTS_STORAGE_KEY = '@mention_drafts';
const DRAFTS_STORAGE_KEY = '@mention_drafts:v2';

export const getDraftsStorageKey = (viewerId: string): string =>
  viewerStorageKey(DRAFTS_STORAGE_KEY, viewerId);

/** Preserve user-authored draft fields while discarding provider-owned snapshots. */
function referenceOnlyDraft(draft: Draft): Draft {
  return {
    ...draft,
    ...(draft.podcast === undefined ? {} : { podcast: podcastReference(draft.podcast) }),
    threadItems:
      draft.threadItems?.map((item) => ({
        ...item,
        ...(item.podcast === undefined ? {} : { podcast: podcastReference(item.podcast) }),
      })) ?? [],
  };
}

/** Compare exactly what storage would retain, ignoring storage-owned metadata. */
function sameStoredContent(existing: Draft, incoming: DraftInput): boolean {
  const {
    id: _existingId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    localRevision: _revision,
    ...stored
  } = existing;
  const { id: _incomingId, ...next } = incoming;
  const storedJson = JSON.stringify(stored);
  const nextJson = JSON.stringify(next);
  if (storedJson === nextJson) return true;
  return sameJsonValue(JSON.parse(storedJson), JSON.parse(nextJson));
}

/** JSON object key order is not content; array order is. */
function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => sameJsonValue(value, b[index]))
    );
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) && sameJsonValue(left[key], right[key]),
    )
  );
}

/** The viewer's drafts as stored — never a list held in some component's state. */
async function readStoredDrafts(viewerId: string): Promise<Draft[]> {
  const stored = await Storage.getStrict<unknown>(getDraftsStorageKey(viewerId));
  if (!stored.found) return [];
  if (!Array.isArray(stored.value)) throw new Error('Stored drafts are not a list');
  return (stored.value as Draft[]).map(referenceOnlyDraft);
}

export const useDrafts = () => {
  const { user } = useAuth();
  const viewerId = user?.id?.trim() || null;
  // Every operation below takes its STORAGE KEY from `operationViewerId`, the
  // closure value — never from this ref — so no draft can be written under the
  // wrong account. What the ref decides is narrower and purely about state: has
  // the viewer changed while this read or write was in flight, i.e. may its
  // result still be shown. Answering that with the COMMITTED viewer is what an
  // Effect gives us, and it is the correct question: a render that never commits
  // is not a viewer the reader ever had. (The render-phase mirror it replaces was
  // also illegal input for the React Compiler.) A lagging answer would strand
  // the guards closed — the drafts list would stay on its spinner after an
  // account switch and stop refreshing when a draft is saved.
  const viewerIdRef = useRefSync(viewerId);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);

  // Load drafts from storage
  const loadDrafts = useCallback(async () => {
    const operationViewerId = viewerId;
    if (!operationViewerId) {
      setDrafts([]);
      setIsLoading(false);
      setIsError(false);
      return;
    }

    try {
      setIsLoading(true);
      const storedDrafts = await readStoredDrafts(operationViewerId);
      if (viewerIdRef.current !== operationViewerId) return;
      // Newest first. Sorted on read too: a list written by an older build may
      // not be in order.
      setDrafts([...storedDrafts].sort((a, b) => b.updatedAt - a.updatedAt));
      setIsError(false);
    } catch (error) {
      if (viewerIdRef.current !== operationViewerId) return;
      logger.error('Error loading drafts', error);
      setIsError(true);
    } finally {
      if (viewerIdRef.current === operationViewerId) {
        setIsLoading(false);
      }
    }
  }, [viewerId]);

  // Save drafts to storage
  const saveDrafts = useCallback(
    async (newDrafts: Draft[]) => {
      const operationViewerId = viewerId;
      if (!operationViewerId) {
        throw new Error('An authenticated viewer is required to save drafts');
      }
      try {
        const saved = await Storage.set(
          getDraftsStorageKey(operationViewerId),
          newDrafts.map(referenceOnlyDraft),
        );
        if (!saved) throw new Error('Failed to write drafts');
        if (viewerIdRef.current === operationViewerId) {
          setDrafts(newDrafts.map(referenceOnlyDraft));
          setIsError(false);
        }
      } catch (error) {
        logger.error('Error saving drafts', error);
        throw error;
      }
    },
    [viewerId],
  );

  // Create or update a draft. Reads the stored list rather than this hook's
  // state, for the same reason `deleteDraft` does: every screen that shows or
  // writes drafts has its own `useDrafts`, so the state here can predate a write
  // another instance (or this one's previous render) made — and a list built
  // from it would silently drop that write, or add a second copy of a draft it
  // did not know was already there.
  const saveDraft = useCallback(
    async (draft: DraftInput, session: DraftSession) => {
      const operationViewerId = viewerId;
      if (!operationViewerId) {
        throw new Error('An authenticated viewer is required to save drafts');
      }
      try {
        return await draftMutationQueue.run(operationViewerId, async () => {
          const currentDrafts = await readStoredDrafts(operationViewerId);
          const now = Date.now();
          const draftId = draft.id || createDraftId();
          if (session.id !== draftId) throw new DraftConflictError();
          const existing = currentDrafts.find((d) => d.id === draftId);
          const existingRevision = existing ? draftRevision(existing.localRevision) : null;
          if (
            existing &&
            session.revision !== null &&
            session.revision !== existingRevision &&
            sameStoredContent(existing, draft)
          ) {
            session.revision = existingRevision;
            return draftId;
          }
          if (
            (session.revision === null && existing) ||
            (session.revision !== null && (!existing || existingRevision !== session.revision))
          )
            throw new DraftConflictError();
          const nextRevision = (session.revision ?? 0) + 1;
          if (!Number.isSafeInteger(nextRevision)) throw new DraftConflictError();

          const draftToSave: Draft = {
            ...draft,
            id: draftId,
            createdAt: existing ? existing.createdAt : now,
            updatedAt: now,
            localRevision: nextRevision,
          };

          // Newest first, as the list is kept: the saved draft is the newest.
          await saveDrafts([draftToSave, ...currentDrafts.filter((d) => d.id !== draftId)]);
          session.revision = nextRevision;
          return draftId;
        });
      } catch (error) {
        logger.error('Error saving draft', error);
        throw error;
      }
    },
    [saveDrafts, viewerId],
  );

  // Delete a draft
  const queueDeleteDraft = useCallback(
    async (getSession: () => DraftSession) => {
      const operationViewerId = viewerId;
      if (!operationViewerId) {
        throw new Error('An authenticated viewer is required to delete drafts');
      }
      try {
        await draftMutationQueue.run(operationViewerId, async () => {
          const session = getSession();
          const draftId = session.id;
          if (!draftId) return;
          logger.debug(`deleteDraft called with draftId: ${draftId}`);
          const currentDrafts = await readStoredDrafts(operationViewerId);
          if (viewerIdRef.current !== operationViewerId) {
            throw new Error('Draft owner changed before deletion');
          }
          const existing = currentDrafts.find((draft) => draft.id === draftId);
          if (session.revision === null && !existing) return;
          if (
            !existing ||
            session.revision === null ||
            draftRevision(existing.localRevision) !== session.revision
          ) {
            throw new DraftConflictError();
          }

          // Filter out the draft to delete
          const newDrafts = currentDrafts.filter((d) => d.id !== draftId);
          logger.debug(
            `Drafts after filtering: ${newDrafts.length}, removed: ${currentDrafts.length - newDrafts.length}`,
          );

          // Save the updated drafts list
          await saveDrafts(newDrafts);
          logger.debug('Drafts saved to storage');
        });
      } catch (error) {
        logger.error('Error deleting draft', error);
        throw error;
      }
    },
    [saveDrafts, viewerId],
  );

  const deleteDraft = useCallback(
    (draftId: string, revision: number) =>
      queueDeleteDraft(() => ({ id: draftId, revision, closed: true, conflicted: false })),
    [queueDeleteDraft],
  );

  /** Read a current draft after earlier local mutations have completed. */
  const readDraft = useCallback(
    async (draftId: string): Promise<Draft | undefined> => {
      const operationViewerId = viewerId;
      if (!operationViewerId) throw new Error('An authenticated viewer is required to read drafts');
      return draftMutationQueue.run(operationViewerId, async () => {
        const currentDrafts = await readStoredDrafts(operationViewerId);
        if (viewerIdRef.current !== operationViewerId)
          throw new Error('Draft owner changed before read');
        return currentDrafts.find((draft) => draft.id === draftId);
      });
    },
    [viewerId],
  );

  // Get a draft by ID
  const getDraft = useCallback(
    (draftId: string): Draft | undefined => {
      return drafts.find((d) => d.id === draftId);
    },
    [drafts],
  );

  // Clear all drafts
  const clearAllDrafts = useCallback(async () => {
    const operationViewerId = viewerId;
    if (!operationViewerId) {
      setDrafts([]);
      return;
    }
    try {
      await draftMutationQueue.run(operationViewerId, async () => {
        const removed = await Storage.remove(getDraftsStorageKey(operationViewerId));
        if (!removed) throw new Error('Failed to clear drafts');
        if (viewerIdRef.current === operationViewerId) {
          setDrafts([]);
          setIsError(false);
        }
      });
    } catch (error) {
      logger.error('Error clearing drafts', error);
      throw error;
    }
  }, [viewerId]);

  // Load drafts on mount
  useEffect(() => {
    // v1 has no owner. Deleting it is the only safe migration on a shared
    // device; assigning it to the first restored session would leak drafts.
    void Storage.remove(LEGACY_DRAFTS_STORAGE_KEY).catch(() => {});
    setDrafts([]);
    setIsError(false);
    if (!viewerId) {
      setIsLoading(false);
      return;
    }
    void loadDrafts();
  }, [loadDrafts, viewerId]);

  return {
    drafts,
    isLoading,
    isError,
    saveDraft,
    deleteDraft,
    queueDeleteDraft,
    readDraft,
    getDraft,
    clearAllDrafts,
    loadDrafts,
  };
};
