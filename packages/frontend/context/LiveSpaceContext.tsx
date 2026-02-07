import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import {
  View,
  Animated,
  StyleSheet,
  Platform,
  Pressable,
  useWindowDimensions,
} from 'react-native';
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
  const { height: screenHeight } = useWindowDimensions();

  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const sheetHeight = isExpanded
    ? screenHeight
    : activeSpaceId
      ? MINI_BAR_HEIGHT + insets.bottom
      : 0;

  const joinLiveSpace = useCallback((spaceId: string) => {
    setActiveSpaceId(spaceId);
    setIsExpanded(true);
  }, []);

  const leaveLiveSpace = useCallback(() => {
    setActiveSpaceId(null);
    setIsExpanded(false);
  }, []);

  const handleCollapse = useCallback(() => {
    setIsExpanded(false);
  }, []);

  const handleExpand = useCallback(() => {
    setIsExpanded(true);
  }, []);

  const contextValue = useMemo(
    () => ({ activeSpaceId, joinLiveSpace, leaveLiveSpace }),
    [activeSpaceId, joinLiveSpace, leaveLiveSpace]
  );

  return (
    <LiveSpaceContext.Provider value={contextValue}>
      {children}

      {/* Backdrop */}
      {activeSpaceId && isExpanded && (
        <Pressable
          style={[StyleSheet.absoluteFill, styles.backdrop]}
          onPress={handleCollapse}
        />
      )}

      {/* Sheet */}
      {activeSpaceId && (
        <View
          style={[
            styles.sheet,
            {
              height: sheetHeight,
              backgroundColor: theme.colors.background,
              paddingBottom: isExpanded ? 0 : insets.bottom,
            },
          ]}
        >
          <LiveSpaceSheet
            spaceId={activeSpaceId}
            isExpanded={isExpanded}
            onCollapse={handleCollapse}
            onExpand={handleExpand}
            onLeave={leaveLiveSpace}
          />
        </View>
      )}
    </LiveSpaceContext.Provider>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    zIndex: 999,
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: 'hidden',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 -4px 12px rgba(0, 0, 0, 0.15)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: -4 },
          shadowOpacity: 0.15,
          shadowRadius: 12,
          elevation: 16,
        }),
  } as any,
});
