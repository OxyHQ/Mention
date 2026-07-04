import React, { memo, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet } from 'react-native';
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useDrawer } from '@/context/DrawerContext';
import { SideBar } from '@/components/SideBar';

export const DrawerOverlay = memo(function DrawerOverlay() {
  const { isOpen, close } = useDrawer();
  const progress = useSharedValue(0);
  const [hasOpened, setHasOpened] = useState(false);

  useEffect(() => {
    if (isOpen && !hasOpened) {
      setHasOpened(true);
    }
    progress.value = withTiming(isOpen ? 1 : 0, { duration: 200 });
  }, [isOpen, progress, hasOpened]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    pointerEvents: (progress.value > 0 ? 'auto' : 'none') as 'auto' | 'none',
  }));

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(progress.value, [0, 1], [-300, 0]) }],
  }));

  if (!hasOpened) return null;

  // POSITIONING: native pins via the `position:'absolute'` insets in `styles`.
  // Web uses document-scroll, where `position:absolute` sinks to the document
  // bottom, so it pins to the viewport with `web:fixed`. The `web:fixed` MUST
  // sit on the SAME element that carries the transform: a transformed ancestor
  // re-traps a `fixed` descendant as its containing block. Mirrors BottomBar.
  return (
    <Animated.View
      className="web:fixed web:inset-0 web:z-[2000]"
      style={[styles.backdrop, backdropStyle]}
    >
      <Pressable style={styles.backdropPressable} onPress={close} />
      <Animated.View
        className="web:fixed web:left-0 web:top-0 web:bottom-0 web:z-[2001]"
        style={[styles.drawer, drawerStyle]}
      >
        <SideBar asDrawer onNavigate={close} />
      </Animated.View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  backdrop: {
    // Native pins the scrim here; web pins via `web:fixed web:inset-0`.
    ...Platform.select({
      web: {},
      default: { position: 'absolute' as const },
    }),
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    zIndex: 2000,
  },
  backdropPressable: {
    ...StyleSheet.absoluteFill,
  },
  drawer: {
    // Native pins the sliding panel here; web pins via `web:fixed web:left-0`.
    ...Platform.select({
      web: {},
      default: { position: 'absolute' as const },
    }),
    top: 0,
    left: 0,
    bottom: 0,
    width: 280,
    zIndex: 2001,
  },
});
