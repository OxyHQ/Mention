import React, { useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Switch } from '@oxyhq/bloom/switch';
import { useHaptics } from '@/hooks/useHaptics';
import type { StyleProp, ViewStyle } from 'react-native';

interface ToggleProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  label?: string;
  disabled?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
}

export const Toggle: React.FC<ToggleProps> = ({
  value,
  onValueChange,
  label,
  disabled = false,
  containerStyle,
}) => {
  const haptic = useHaptics();

  const handleValueChange = useCallback((newValue: boolean) => {
    haptic('Light');
    onValueChange(newValue);
  }, [haptic, onValueChange]);

  return (
    <View style={[styles.container, containerStyle]}>
      {label && (
        <Text className="text-foreground" style={styles.label}>
          {label}
        </Text>
      )}
      <Switch
        value={value}
        onValueChange={handleValueChange}
        disabled={disabled}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  label: {
    fontSize: 16,
    flex: 1,
    marginRight: 12,
  },
});
