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

import { useAgoraConfig } from './AgoraConfigContext';
import { LiveRoomSheet } from '../components/LiveRoomSheet';
import { MINI_BAR_HEIGHT } from '../components/MiniRoomBar';

interface LiveRoomContextProps {
  activeRoomId: string | null;
  joinLiveRoom: (roomId: string) => void;
  leaveLiveRoom: () => void;
}

const LiveRoomContext = createContext<LiveRoomContextProps>({
  activeRoomId: null,
  joinLiveRoom: () => {},
  leaveLiveRoom: () => {},
});

export function useLiveRoom() {
  return useContext(LiveRoomContext);
}

const SPRING_CONFIG = { damping: 28, stiffness: 220, overshootClamping: true };
// Bottom bar: bottom 12 + height 56 + gap 8
const BOTTOM_BAR_OFFSET = 76;
const defaultUseIsDesktop = () => false;

export function LiveRoomProvider({ children }: { children: React.ReactNode }) {
  const config = useAgoraConfig();
  const theme = config.useTheme();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();

  const useIsDesktopHook = config.useIsDesktop ?? defaultUseIsDesktop;
  const isDesktop = useIsDesktopHook();

  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
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

  const joinLiveRoom = useCallback((roomId: string) => {
    setActiveRoomId(roomId);
    setIsExpanded(true);
    progress.value = withSpring(2, SPRING_CONFIG);
  }, [progress]);

  const clearRoom = useCallback(() => {
    setActiveRoomId(null);
    setIsExpanded(false);
  }, []);

  const leaveLiveRoom = useCallback(() => {
    setIsExpanded(false);
    progress.value = withTiming(0, { duration: 250 }, (finished) => {
      if (finished) runOnJS(clearRoom)();
    });
  }, [progress, clearRoom]);

  const handleCollapse = useCallback(() => {
    setIsExpanded(false);
    progress.value = withSpring(1, SPRING_CONFIG);
  }, [progress]);

  const handleExpand = useCallback(() => {
    setIsExpanded(true);
    progress.value = withSpring(2, SPRING_CONFIG);
  }, [progress]);

  const contextValue = useMemo(
    () => ({ activeRoomId, joinLiveRoom, leaveLiveRoom }),
    [activeRoomId, joinLiveRoom, leaveLiveRoom]
  );

  return (
    <LiveRoomContext.Provider value={contextValue}>
      {children}

      {activeRoomId && (
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.backdrop, backdropAnimStyle]}
          pointerEvents={isExpanded ? 'auto' : 'none'}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={handleCollapse} />
        </Animated.View>
      )}

      {activeRoomId && (
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
            <LiveRoomSheet
              roomId={activeRoomId}
              isExpanded={isExpanded}
              onCollapse={handleCollapse}
              onExpand={handleExpand}
              onLeave={leaveLiveRoom}
            />
          ) : (
            <BlurView
              intensity={80}
              tint={theme.isDark ? 'dark' : 'light'}
              experimentalBlurMethod="dimezisBlurView"
              style={{ flex: 1 }}
            >
              <LiveRoomSheet
                roomId={activeRoomId}
                isExpanded={isExpanded}
                onCollapse={handleCollapse}
                onExpand={handleExpand}
                onLeave={leaveLiveRoom}
              />
            </BlurView>
          )}
        </Animated.View>
      )}
    </LiveRoomContext.Provider>
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
    alignSelf: 'center',
    zIndex: 1000,
    overflow: 'hidden',
    borderWidth: 1,
  },
});
