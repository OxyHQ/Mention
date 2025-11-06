import React, { useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

interface ToggleProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  label?: string;
  disabled?: boolean;
  containerStyle?: any;
}

export const Toggle: React.FC<ToggleProps> = ({
  value,
  onValueChange,
  label,
  disabled = false,
  containerStyle,
}) => {
  const theme = useTheme();
  const switchAnimation = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(switchAnimation, {
      toValue: value ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [value]);

  return (
    <View style={[styles.container, containerStyle]}>
      {label && (
        <Text style={[styles.label, { color: theme.colors.text }]}>
          {label}
        </Text>
      )}
      <TouchableOpacity
        style={[
          styles.switchContainer,
          {
            backgroundColor: value ? theme.colors.primary : theme.colors.border,
            opacity: disabled ? 0.5 : 1,
          }
        ]}
        onPress={() => !disabled && onValueChange(!value)}
        activeOpacity={0.8}
        disabled={disabled}
      >
        <Animated.View
          style={[
            styles.switchThumb,
            {
              backgroundColor: theme.colors.card,
              transform: [
                {
                  translateX: switchAnimation.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, 18],
                  }),
                },
              ],
            }
          ]}
        />
      </TouchableOpacity>
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
  switchContainer: {
    width: 44,
    height: 26,
    borderRadius: 13,
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  switchThumb: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
});

