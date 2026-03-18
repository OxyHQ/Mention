import { useState, useEffect, useCallback } from 'react';
import { storeData, getData, removeData } from '@/utils/storage';
import { createScopedLogger } from '@/lib/logger';

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
  createdAt: number;
  updatedAt: number;
}

const DRAFTS_STORAGE_KEY = '@mention_drafts';

export const useDrafts = () => {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Load drafts from storage
  const loadDrafts = useCallback(async () => {
    try {
      setIsLoading(true);
      const storedDrafts = await getData<Draft[]>(DRAFTS_STORAGE_KEY);
      if (storedDrafts && Array.isArray(storedDrafts)) {
        // Sort by updatedAt descending
        const sorted = storedDrafts.sort((a, b) => b.updatedAt - a.updatedAt);
        setDrafts(sorted);
      } else {
        setDrafts([]);
      }
    } catch (error) {
      logger.error('Error loading drafts');
      setDrafts([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Save drafts to storage
  const saveDrafts = useCallback(async (newDrafts: Draft[]) => {
    try {
      await storeData(DRAFTS_STORAGE_KEY, newDrafts);
      setDrafts(newDrafts);
    } catch (error) {
      logger.error('Error saving drafts');
    }
  }, []);

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
      logger.error('Error saving draft');
      throw error;
    }
  }, [drafts, saveDrafts]);

  // Delete a draft
  const deleteDraft = useCallback(async (draftId: string) => {
    try {
      logger.debug(`deleteDraft called with draftId: ${draftId}`);
      // Read latest drafts from storage to avoid stale state
      const storedDrafts = await getData<Draft[]>(DRAFTS_STORAGE_KEY);
      logger.debug(`Stored drafts: ${storedDrafts?.length || 0}`);
      const currentDrafts = storedDrafts && Array.isArray(storedDrafts) ? storedDrafts : [];

      // Filter out the draft to delete
      const newDrafts = currentDrafts.filter(d => d.id !== draftId);
      logger.debug(`Drafts after filtering: ${newDrafts.length}, removed: ${currentDrafts.length - newDrafts.length}`);

      // Save the updated drafts list
      await saveDrafts(newDrafts);
      logger.debug('Drafts saved to storage');

      // Ensure state is updated
      setDrafts(newDrafts);
      logger.debug('State updated');
    } catch (error) {
      logger.error('Error deleting draft');
      throw error;
    }
  }, [saveDrafts]);

  // Get a draft by ID
  const getDraft = useCallback((draftId: string): Draft | undefined => {
    return drafts.find(d => d.id === draftId);
  }, [drafts]);

  // Clear all drafts
  const clearAllDrafts = useCallback(async () => {
    try {
      await removeData(DRAFTS_STORAGE_KEY);
      setDrafts([]);
    } catch (error) {
      logger.error('Error clearing drafts');
      throw error;
    }
  }, []);

  // Load drafts on mount
  useEffect(() => {
    loadDrafts();
  }, [loadDrafts]);

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

