import { useState, useCallback } from "react";

export interface SpaceAttachmentData {
  spaceId: string;
  title: string;
  status?: 'scheduled' | 'live' | 'ended';
  topic?: string;
  host?: string;
}

export const useSpaceManager = () => {
  const [space, setSpace] = useState<SpaceAttachmentData | null>(null);

  const attachSpace = useCallback((data: SpaceAttachmentData) => {
    setSpace(data);
  }, []);

  const removeSpace = useCallback(() => {
    setSpace(null);
  }, []);

  const hasContent = useCallback(() => {
    if (!space) return false;
    return Boolean(space.spaceId && space.title?.trim());
  }, [space]);

  const loadSpaceFromDraft = useCallback((draftSpace: SpaceAttachmentData | null) => {
    setSpace(draftSpace);
  }, []);

  const clearSpace = useCallback(() => {
    setSpace(null);
  }, []);

  return {
    space,
    setSpace,
    attachSpace,
    removeSpace,
    hasContent,
    loadSpaceFromDraft,
    clearSpace,
  };
};
