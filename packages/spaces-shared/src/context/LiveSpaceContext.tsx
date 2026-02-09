import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { StyleSheet, Pressable, useWindowDimensions, Platform } from 'react-native';
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
import { BlurView } from 'expo-blur';

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
const defaultUseIsDesktop = () => false;

export function LiveSpaceProvider({ children }: { children: React.ReactNode }) {
  const config = useSpacesConfig();
  const theme = config.useTheme();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();

  const useIsDesktopHook = config.useIsDesktop ?? defaultUseIsDesktop;
  const isDesktop = useIsDesktopHook();

  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const hasBottomBar = !isDesktop;
  const bottomBarOffset = hasBottomBar ? BOTTOM_BAR_OFFSET : 12;
  const collapsedHeight = MINI_BAR_HEIGHT;
  const expandedMaxHeight = screenHeight * 0.85 - bottomBarOffset;

  const progress = useSharedValue(0);

  const sheetAnimStyle = useAnimatedStyle(() => {
    const h = interpolate(
      progress.value,
      [0, 1, 2],
      [0, collapsedHeight, expandedMaxHeight],
      Extrapolation.CLAMP,
    );
    const inset = 16;
    const topRadius = interpolate(
      progress.value,
      [1, 2],
      [collapsedHeight / 2, 16],
      Extrapolation.CLAMP,
    );
    const bottomRadius = interpolate(
      progress.value,
      [1, 2],
      [collapsedHeight / 2, 16],
      Extrapolation.CLAMP,
    );
    return {
      height: h,
      left: inset,
      right: inset,
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
              bottom: bottomBarOffset,
              borderColor: theme.colors.border,
              ...(Platform.OS === 'web' ? {
                backgroundColor: `${theme.colors.card}CC`,
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                boxShadow: `0 2px 16px ${theme.colors.shadow}`,
              } : {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.15,
                shadowRadius: 12,
                elevation: 8,
              }),
            },
            sheetAnimStyle,
          ]}
        >
          {Platform.OS === 'web' ? (
            <LiveSpaceSheet
              spaceId={activeSpaceId}
              isExpanded={isExpanded}
              onCollapse={handleCollapse}
              onExpand={handleExpand}
              onLeave={leaveLiveSpace}
            />
          ) : (
            <BlurView
              intensity={80}
              tint={theme.isDark ? 'dark' : 'light'}
              style={{ flex: 1 }}
            >
              <LiveSpaceSheet
                spaceId={activeSpaceId}
                isExpanded={isExpanded}
                onCollapse={handleCollapse}
                onExpand={handleExpand}
                onLeave={leaveLiveSpace}
              />
            </BlurView>
          )}
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
  } as any,
});
