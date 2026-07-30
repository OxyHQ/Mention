import { useState, useEffect, useCallback } from 'react';
import { Storage } from '@/utils/storage';
import { createScopedLogger } from '@/lib/logger';
import type { DraftVariants } from '@/utils/composeVariants';
import { useAuth } from '@oxyhq/services/ui/client';
import { viewerStorageKey } from '@/lib/viewerQueryKeys';
import { useRefSync } from '@/hooks/useRefSync';

const logger = createScopedLogger('useDrafts');

export interface Draft {
  id: string;
  postContent: string;
  mediaIds: Array<{ id: string; type: 'image' | 'video' | 'gif' }>;
  pollOptions: string[];
  pollTitle?: string;
  showPollCreator: boolean;
  location: { latitude: number; longitude: number; address?: string } | null;
  sources?: Array<{ id?: string; title?: string; url?: string }>;
  article?: { title?: string; body?: string } | null;
  podcast?: { syraPodcastId: string; title: string; author?: string; artworkUrl?: string } | null;
  attachmentOrder?: string[];
  scheduledAt?: string | null;
  threadItems: Array<{
    id: string;
    text: string;
    mediaIds: Array<{ id: string; type: 'image' | 'video' | 'gif' }>;
    pollOptions: string[];
    pollTitle?: string;
    showPollCreator: boolean;
    location: { latitude: number; longitude: number; address?: string } | null;
    mentions: Array<{ userId: string; handle: string; name: string }>;
  }>;
  mentions: Array<{ userId: string; handle: string; name: string }>;
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
}

const LEGACY_DRAFTS_STORAGE_KEY = '@mention_drafts';
const DRAFTS_STORAGE_KEY = '@mention_drafts:v2';

export const getDraftsStorageKey = (viewerId: string): string =>
  viewerStorageKey(DRAFTS_STORAGE_KEY, viewerId);

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

  // Load drafts from storage
  const loadDrafts = useCallback(async () => {
    const operationViewerId = viewerId;
    if (!operationViewerId) {
      setDrafts([]);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      const storedDrafts = await Storage.get<Draft[]>(
        getDraftsStorageKey(operationViewerId),
      );
      if (viewerIdRef.current !== operationViewerId) return;
      if (storedDrafts && Array.isArray(storedDrafts)) {
        // Sort by updatedAt descending
        const sorted = [...storedDrafts].sort(
          (a, b) => b.updatedAt - a.updatedAt,
        );
        setDrafts(sorted);
      } else {
        setDrafts([]);
      }
    } catch (error) {
      if (viewerIdRef.current !== operationViewerId) return;
      logger.error('Error loading drafts', { error });
      setDrafts([]);
    } finally {
      if (viewerIdRef.current === operationViewerId) {
        setIsLoading(false);
      }
    }
  }, [viewerId]);

  // Save drafts to storage
  const saveDrafts = useCallback(async (newDrafts: Draft[]) => {
    const operationViewerId = viewerId;
    if (!operationViewerId) {
      throw new Error('An authenticated viewer is required to save drafts');
    }
    try {
      await Storage.set(
        getDraftsStorageKey(operationViewerId),
        newDrafts,
      );
      if (viewerIdRef.current === operationViewerId) {
        setDrafts(newDrafts);
      }
    } catch (error) {
      logger.error('Error saving drafts', { error });
      if (viewerIdRef.current !== operationViewerId) return;
      throw error;
    }
  }, [viewerId]);

  // Create or update a draft
  const saveDraft = useCallback(async (draft: Omit<Draft, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) => {
    try {
      const now = Date.now();
      const draftId = draft.id || `draft_${now}_${Math.random().toString(36).substr(2, 9)}`;
      
      const existingDraftIndex = drafts.findIndex(d => d.id === draftId);
      
      const draftToSave: Draft = {
        ...draft,
        id: draftId,
        createdAt: existingDraftIndex >= 0 ? drafts[existingDraftIndex].createdAt : now,
        updatedAt: now,
      };

      let newDrafts: Draft[];
      if (existingDraftIndex >= 0) {
        // Update existing draft
        newDrafts = [...drafts];
        newDrafts[existingDraftIndex] = draftToSave;
      } else {
        // Add new draft
        newDrafts = [draftToSave, ...drafts];
      }

      // Sort by updatedAt descending
      newDrafts.sort((a, b) => b.updatedAt - a.updatedAt);
      
      await saveDrafts(newDrafts);
      return draftId;
    } catch (error) {
      logger.error('Error saving draft', { error });
      throw error;
    }
  }, [drafts, saveDrafts]);

  // Delete a draft
  const deleteDraft = useCallback(async (draftId: string) => {
    const operationViewerId = viewerId;
    if (!operationViewerId) {
      throw new Error('An authenticated viewer is required to delete drafts');
    }
    try {
      logger.debug(`deleteDraft called with draftId: ${draftId}`);
      // Read latest drafts from storage to avoid stale state
      const storedDrafts = await Storage.get<Draft[]>(
        getDraftsStorageKey(operationViewerId),
      );
      if (viewerIdRef.current !== operationViewerId) return;
      logger.debug(`Stored drafts: ${storedDrafts?.length || 0}`);
      const currentDrafts = storedDrafts && Array.isArray(storedDrafts) ? storedDrafts : [];

      // Filter out the draft to delete
      const newDrafts = currentDrafts.filter(d => d.id !== draftId);
      logger.debug(`Drafts after filtering: ${newDrafts.length}, removed: ${currentDrafts.length - newDrafts.length}`);

      // Save the updated drafts list
      await saveDrafts(newDrafts);
      logger.debug('Drafts saved to storage');
    } catch (error) {
      logger.error('Error deleting draft', { error });
      throw error;
    }
  }, [saveDrafts, viewerId]);

  // Get a draft by ID
  const getDraft = useCallback((draftId: string): Draft | undefined => {
    return drafts.find(d => d.id === draftId);
  }, [drafts]);

  // Clear all drafts
  const clearAllDrafts = useCallback(async () => {
    const operationViewerId = viewerId;
    if (!operationViewerId) {
      setDrafts([]);
      return;
    }
    try {
      await Storage.remove(getDraftsStorageKey(operationViewerId));
      if (viewerIdRef.current === operationViewerId) {
        setDrafts([]);
      }
    } catch (error) {
      logger.error('Error clearing drafts', { error });
      throw error;
    }
  }, [viewerId]);

  // Load drafts on mount
  useEffect(() => {
    // v1 has no owner. Deleting it is the only safe migration on a shared
    // device; assigning it to the first restored session would leak drafts.
    void Storage.remove(LEGACY_DRAFTS_STORAGE_KEY).catch(() => {});
    setDrafts([]);
    if (!viewerId) {
      setIsLoading(false);
      return;
    }
    void loadDrafts();
  }, [loadDrafts, viewerId]);

  return {
    drafts,
    isLoading,
    saveDraft,
    deleteDraft,
    getDraft,
    clearAllDrafts,
    loadDrafts,
  };
};
