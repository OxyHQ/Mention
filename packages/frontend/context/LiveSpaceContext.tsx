import React, { createContext, useContext, useState, useRef, useCallback, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import BottomSheet, { BottomSheetBackdrop, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/hooks/useTheme';
import { LiveSpaceSheet } from '@/components/spaces/LiveSpaceSheet';
import { MINI_BAR_HEIGHT } from '@/components/spaces/MiniSpaceBar';

interface LiveSpaceContextProps {
  activeSpaceId: string | null;
  joinLiveSpace: (spaceId: string) => void;
  leaveLiveSpace: () => void;
}

const LiveSpaceContext = createContext<LiveSpaceContextProps>({
  activeSpaceId: null,
  joinLiveSpace: () => {},
  leaveLiveSpace: () => {},
});

export function useLiveSpace() {
  return useContext(LiveSpaceContext);
}

export function LiveSpaceProvider({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheet>(null);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [sheetIndex, setSheetIndex] = useState(-1);

  const snapPoints = useMemo(
    () => [MINI_BAR_HEIGHT + insets.bottom, '100%'],
    [insets.bottom]
  );

  const joinLiveSpace = useCallback((spaceId: string) => {
    setActiveSpaceId(spaceId);
    requestAnimationFrame(() => {
      sheetRef.current?.snapToIndex(1);
    });
  }, []);

  const leaveLiveSpace = useCallback(() => {
    sheetRef.current?.close();
    setTimeout(() => {
      setActiveSpaceId(null);
      setSheetIndex(-1);
    }, 300);
  }, []);

  const handleCollapse = useCallback(() => {
    sheetRef.current?.snapToIndex(0);
  }, []);

  const handleExpand = useCallback(() => {
    sheetRef.current?.snapToIndex(1);
  }, []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={1}
        disappearsOnIndex={0}
        pressBehavior="none"
        opacity={0.3}
      />
    ),
    []
  );

  const contextValue = useMemo(
    () => ({ activeSpaceId, joinLiveSpace, leaveLiveSpace }),
    [activeSpaceId, joinLiveSpace, leaveLiveSpace]
  );

  return (
    <LiveSpaceContext.Provider value={contextValue}>
      {children}
      {activeSpaceId && (
        <BottomSheet
          ref={sheetRef}
          snapPoints={snapPoints}
          index={-1}
          enablePanDownToClose={false}
          enableContentPanningGesture={false}
          topInset={insets.top}
          handleComponent={null}
          backgroundStyle={{ backgroundColor: theme.colors.background }}
          style={styles.sheet}
          backdropComponent={renderBackdrop}
          onChange={(index) => {
            setSheetIndex(index);
            if (index === -1 && activeSpaceId) {
              setActiveSpaceId(null);
            }
          }}
        >
          <LiveSpaceSheet
            spaceId={activeSpaceId}
            isExpanded={sheetIndex >= 1}
            onCollapse={handleCollapse}
            onExpand={handleExpand}
            onLeave={leaveLiveSpace}
          />
        </BottomSheet>
      )}
    </LiveSpaceContext.Provider>
  );
}

const styles = StyleSheet.create({
  sheet: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 16,
  },
});
