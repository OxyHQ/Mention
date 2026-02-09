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
// Bottom bar: bottom 12 + height 56 + gap 8
const BOTTOM_BAR_OFFSET = 76;

export function LiveSpaceProvider({ children }: { children: React.ReactNode }) {
  const { useTheme, isDesktop } = useSpacesConfig();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();

  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const bottomBarOffset = isDesktop ? 0 : BOTTOM_BAR_OFFSET;
  const collapsedHeight = MINI_BAR_HEIGHT;
  const expandedMaxHeight = screenHeight * 0.85;

  const progress = useSharedValue(0);

  const sheetAnimStyle = useAnimatedStyle(() => {
    const h = interpolate(
      progress.value,
      [0, 1, 2],
      [0, collapsedHeight, expandedMaxHeight],
      Extrapolation.CLAMP,
    );
    const bottom = isDesktop ? 0 : interpolate(
      progress.value,
      [1, 2],
      [bottomBarOffset, 0],
      Extrapolation.CLAMP,
    );
    const inset = isDesktop ? 0 : interpolate(
      progress.value,
      [1, 2],
      [16, 0],
      Extrapolation.CLAMP,
    );
    const pb = isDesktop ? 0 : interpolate(
      progress.value,
      [1, 2],
      [0, bottomBarOffset],
      Extrapolation.CLAMP,
    );
    const topRadius = interpolate(
      progress.value,
      [1, 2],
      [collapsedHeight / 2, 16],
      Extrapolation.CLAMP,
    );
    const bottomRadius = interpolate(
      progress.value,
      [1, 2],
      [collapsedHeight / 2, 0],
      Extrapolation.CLAMP,
    );
    return {
      height: h,
      bottom,
      left: inset,
      right: inset,
      paddingBottom: pb,
      borderTopLeftRadius: topRadius,
      borderTopRightRadius: topRadius,
      borderBottomLeftRadius: bottomRadius,
      borderBottomRightRadius: bottomRadius,
    };
  });

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
              backgroundColor: theme.colors.background,
              borderColor: theme.colors.border,
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
    maxWidth: 500,
    margin: 'auto',
    zIndex: 1000,
    overflow: 'hidden',
    borderWidth: 1,
    boxShadow: '0 2px 16px rgba(0, 0, 0, 0.15)',
    elevation: 8,
  } as any,
});
