import { useCallback } from 'react';
import { Platform } from 'react-native';
import { impactAsync, ImpactFeedbackStyle } from 'expo-haptics';
import { useHapticsStore } from '@/stores/hapticsStore';

export function useHaptics() {
  const disabled = useHapticsStore((s) => s.disabled);

  return useCallback(
    (strength: 'Light' | 'Medium' | 'Heavy' = 'Medium') => {
      if (disabled || Platform.OS === 'web') {
        return;
      }

      // Android users report medium haptics as too strong, so always use Light there
      const style =
        Platform.OS === 'ios'
          ? ImpactFeedbackStyle[strength]
          : ImpactFeedbackStyle.Light;
      impactAsync(style);
    },
    [disabled],
  );
}
