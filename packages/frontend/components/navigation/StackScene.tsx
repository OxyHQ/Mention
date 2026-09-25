import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useSurfaceFill } from '@oxy.so/bloom/styles';

/**
 * The frame of every native stack screen: the `screenLayout` of the stack in
 * `app/(app)/_layout.tsx`.
 *
 * It paints the panel's own fill. The stack sits inside Bloom's AppShell panel
 * and its scene wrapper is transparent (patches/README.md), so a screen that did
 * not paint a background of its own let the screen under it show through (#1126).
 * `useSurfaceFill` is the colour the panel paints here, including a profile's
 * scoped colour, so a screen looks exactly as it did — only now opaque.
 *
 * It also takes every screen but the top one out of the accessibility tree. A
 * pushed screen leaves the screens under it mounted, and TalkBack otherwise walks
 * straight into the feed behind a post.
 */
export function StackScene({ children }: { children: ReactNode }) {
  const fill = useSurfaceFill();
  const focused = useIsFocused();
  return (
    <View
      style={[styles.scene, { backgroundColor: fill }]}
      importantForAccessibility={focused ? 'auto' : 'no-hide-descendants'}
      accessibilityElementsHidden={!focused}
    >
      {children}
    </View>
  );
}

export function stackSceneLayout({ children }: { children: ReactNode }) {
  return <StackScene>{children}</StackScene>;
}

const styles = StyleSheet.create({
  scene: { flex: 1 },
});
