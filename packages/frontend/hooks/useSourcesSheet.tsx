import { useState, useCallback, useMemo, useEffect, lazy, Suspense } from 'react';
import React from 'react';
// Lazy load SourcesSheet - only loaded when user opens it
const SourcesSheet = lazy(() => import('@/components/Compose/SourcesSheet'));

interface Source {
  id: string;
  url: string;
  title: string;
}

interface UseSourcesSheetProps {
  sources: Source[];
  addSource: () => void;
  updateSourceField: (id: string, field: 'url' | 'title', value: string) => void;
  removeSourceEntry: (id: string) => void;
  isValidSourceUrl: (url: string) => boolean;
  bottomSheet: {
    setBottomSheetContent: (content: any) => void;
    openBottomSheet: (open: boolean) => void;
  };
}

export const useSourcesSheet = ({
  sources,
  addSource,
  updateSourceField,
  removeSourceEntry,
  isValidSourceUrl,
  bottomSheet,
}: UseSourcesSheetProps) => {
  const [isSourcesSheetOpen, setIsSourcesSheetOpen] = useState(false);

  const closeSourcesSheet = useCallback(() => {
    setIsSourcesSheetOpen((prev) => {
      if (prev) {
        bottomSheet.openBottomSheet(false);
        bottomSheet.setBottomSheetContent(null);
      }
      return false;
    });
  }, [bottomSheet]);

  const sourcesSheetElement = useMemo(() => (
    <Suspense fallback={null}>
      <SourcesSheet
        sources={sources}
        onAdd={addSource}
        onUpdate={updateSourceField}
        onRemove={removeSourceEntry}
        onClose={closeSourcesSheet}
        validateUrl={isValidSourceUrl}
      />
    </Suspense>
  ), [sources, addSource, updateSourceField, removeSourceEntry, closeSourcesSheet, isValidSourceUrl]);

  const openSourcesSheet = useCallback(() => {
    bottomSheet.setBottomSheetContent(sourcesSheetElement);
    bottomSheet.openBottomSheet(true);
    setIsSourcesSheetOpen(true);
  }, [bottomSheet, sourcesSheetElement]);

  useEffect(() => {
    if (isSourcesSheetOpen) {
      bottomSheet.setBottomSheetContent(sourcesSheetElement);
    }
  }, [isSourcesSheetOpen, bottomSheet, sourcesSheetElement]);

  return {
    isSourcesSheetOpen,
    openSourcesSheet,
    closeSourcesSheet,
  };
};
