import { useState, useEffect, useCallback } from 'react';
import { storeData, getData, removeData } from '@/utils/storage';

export interface Draft {
  id: string;
  postContent: string;
  mediaIds: Array<{ id: string; type: 'image' | 'video' }>;
  pollOptions: string[];
  showPollCreator: boolean;
  location: { latitude: number; longitude: number; address?: string } | null;
  threadItems: Array<{
    id: string;
    text: string;
    mediaIds: Array<{ id: string; type: 'image' | 'video' }>;
    pollOptions: string[];
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
      console.error('Error loading drafts:', error);
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
      console.error('Error saving drafts:', error);
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
      console.error('Error saving draft:', error);
      throw error;
    }
  }, [drafts, saveDrafts]);

  // Delete a draft
  const deleteDraft = useCallback(async (draftId: string) => {
    try {
      const newDrafts = drafts.filter(d => d.id !== draftId);
      await saveDrafts(newDrafts);
    } catch (error) {
      console.error('Error deleting draft:', error);
      throw error;
    }
  }, [drafts, saveDrafts]);

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
      console.error('Error clearing drafts:', error);
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

