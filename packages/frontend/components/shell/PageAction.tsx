import type { ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { useBottomEdgeInset } from '@oxy.so/bloom/layout';

/** Route action placement follows the shell's measured bottom navigation. */
export function PageAction({ children }: { children: ReactNode }) {
  const bottom = useBottomEdgeInset() + 16;
  return (
    <View
      className="self-end web:sticky native:absolute native:right-4 web:mr-4 web:mt-auto"
      style={{ bottom, ...(Platform.OS === 'web' ? { marginBottom: bottom } : {}) }}
    >
      {children}
    </View>
  );
}
