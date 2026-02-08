import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { StyleSheet, Pressable, useWindowDimensions } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  Extrapolation,
  runOnJS,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSpacesConfig } from './SpacesConfigContext';
import { LiveSpaceSheet } from '../components/LiveSpaceSheet';
import { MINI_BAR_HEIGHT } from '../components/MiniSpaceBar';

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

const SPRING_CONFIG = { damping: 28, stiffness: 220, overshootClamping: true };
const BOTTOM_BAR_BASE = 60;

export function LiveSpaceProvider({ children }: { children: React.ReactNode }) {
  const { useTheme, isDesktop } = useSpacesConfig();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();

  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const bottomOffset = isDesktop ? 0 : BOTTOM_BAR_BASE + insets.bottom;
  const collapsedHeight = MINI_BAR_HEIGHT;
  const expandedMaxHeight = screenHeight * 0.85 - bottomOffset;

  const progress = useSharedValue(0);

  const sheetAnimStyle = useAnimatedStyle(() => ({
    height: interpolate(
      progress.value,
      [0, 1, 2],
      [0, collapsedHeight, expandedMaxHeight],
      Extrapolation.CLAMP,
    ),
  }));

  const backdropAnimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [1, 2], [0, 1], Extrapolation.CLAMP),
  }));

  const joinLiveSpace = useCallback((spaceId: string) => {
    setActiveSpaceId(spaceId);
    setIsExpanded(true);
    progress.value = withSpring(2, SPRING_CONFIG);
  }, [progress]);

  const clearSpace = useCallback(() => {
    setActiveSpaceId(null);
    setIsExpanded(false);
  }, []);

  const leaveLiveSpace = useCallback(() => {
    setIsExpanded(false);
    progress.value = withTiming(0, { duration: 250 }, (finished) => {
      if (finished) runOnJS(clearSpace)();
    });
  }, [progress, clearSpace]);

  const handleCollapse = useCallback(() => {
    setIsExpanded(false);
    progress.value = withSpring(1, SPRING_CONFIG);
  }, [progress]);

  const handleExpand = useCallback(() => {
    setIsExpanded(true);
    progress.value = withSpring(2, SPRING_CONFIG);
  }, [progress]);

  const contextValue = useMemo(
    () => ({ activeSpaceId, joinLiveSpace, leaveLiveSpace }),
    [activeSpaceId, joinLiveSpace, leaveLiveSpace]
  );

  return (
    <LiveSpaceContext.Provider value={contextValue}>
      {children}

      {activeSpaceId && (
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.backdrop, backdropAnimStyle]}
          pointerEvents={isExpanded ? 'auto' : 'none'}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={handleCollapse} />
        </Animated.View>
      )}

      {activeSpaceId && (
        <Animated.View
          style={[
            styles.sheet,
            {
              bottom: bottomOffset,
              backgroundColor: theme.colors.background,
            },
            sheetAnimStyle,
          ]}
        >
          <LiveSpaceSheet
            spaceId={activeSpaceId}
            isExpanded={isExpanded}
            onCollapse={handleCollapse}
            onExpand={handleExpand}
            onLeave={leaveLiveSpace}
          />
        </Animated.View>
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
    left: 0,
    right: 0,
    maxWidth: 500,
    margin: 'auto',
    zIndex: 1000,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: 'hidden',
    boxShadow: '0 -4px 12px rgba(0, 0, 0, 0.15)',
    elevation: 16,
  } as any,
});
