import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  runOnJS,
} from 'react-native-reanimated';
import { useTheme } from '@/hooks/useTheme';

interface SliderProps {
  value: number;
  onValueChange: (value: number) => void;
  minimumValue?: number;
  maximumValue?: number;
  step?: number;
  label?: string;
  formatValue?: (value: number) => string;
  disabled?: boolean;
  showValue?: boolean;
}

export const Slider: React.FC<SliderProps> = ({
  value,
  onValueChange,
  minimumValue = 0,
  maximumValue = 1,
  step = 0.01,
  label,
  formatValue,
  disabled = false,
  showValue = true,
}) => {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const widthSV = useSharedValue(0);
  const translateX = useSharedValue(0);
  const isDragging = useSharedValue(false);

  // Update position when value changes externally
  useEffect(() => {
    if (!isDragging.value && width > 0) {
      const range = maximumValue - minimumValue;
      const percentage = (value - minimumValue) / range;
      translateX.value = Math.max(0, Math.min(width, percentage * width));
    }
  }, [value, width, minimumValue, maximumValue]);

  const gesture = useMemo(() => {
    return Gesture.Pan()
      .enabled(!disabled)
      .minDistance(0)
      .onStart((e) => {
        'worklet';
        isDragging.value = true;
        if (widthSV.value > 0) {
          const newPos = Math.max(0, Math.min(widthSV.value, e.x));
          translateX.value = newPos;

          const percentage = newPos / widthSV.value;
          const rawValue = minimumValue + percentage * (maximumValue - minimumValue);
          const steppedValue = Math.round(rawValue / step) * step;
          const finalValue = Math.max(minimumValue, Math.min(maximumValue, steppedValue));

          runOnJS(onValueChange)(finalValue);
        }
      })
      .onUpdate((e) => {
        'worklet';
        if (widthSV.value > 0) {
          const newPos = Math.max(0, Math.min(widthSV.value, e.x));
          translateX.value = newPos;

          const percentage = newPos / widthSV.value;
          const rawValue = minimumValue + percentage * (maximumValue - minimumValue);
          const steppedValue = Math.round(rawValue / step) * step;
          const finalValue = Math.max(minimumValue, Math.min(maximumValue, steppedValue));

          runOnJS(onValueChange)(finalValue);
        }
      })
      .onEnd(() => {
        'worklet';
        isDragging.value = false;
      });
  }, [disabled, minimumValue, maximumValue, step, onValueChange, widthSV, isDragging, translateX]);

  const thumbStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateX: translateX.value }],
    };
  });

  const fillStyle = useAnimatedStyle(() => {
    return {
      width: translateX.value,
    };
  });

  const displayValue = formatValue ? formatValue(value) : value.toFixed(step < 1 ? 2 : 0);

  return (
    <View style={styles.container}>
      {label && (
        <View style={styles.labelRow}>
          <Text style={[styles.label, { color: theme.colors.text }]}>{label}</Text>
          {showValue && (
            <Text style={[styles.value, { color: theme.colors.primary }]}>{displayValue}</Text>
          )}
        </View>
      )}
      <GestureDetector gesture={gesture}>
        <View
          style={styles.trackContainer}
          onLayout={(e) => {
            const newWidth = e.nativeEvent.layout.width;
            setWidth(newWidth);
            widthSV.value = newWidth;
          }}
        >
          <View
            style={[
              styles.track,
              { backgroundColor: theme.colors.border },
              disabled && { opacity: 0.5 },
            ]}
          />
          <Animated.View
            style={[
              styles.fill,
              { backgroundColor: theme.colors.primary },
              disabled && { opacity: 0.5 },
              fillStyle,
            ]}
          />
          <Animated.View
            style={[
              styles.thumb,
              {
                backgroundColor: theme.colors.card,
                borderColor: theme.colors.primary,
              },
              disabled && { opacity: 0.5 },
              thumbStyle,
            ]}
          />
        </View>
      </GestureDetector>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
  },
  value: {
    fontSize: 14,
    fontWeight: '600',
  },
  trackContainer: {
    height: 40,
    justifyContent: 'center',
    position: 'relative',
  },
  track: {
    height: 4,
    borderRadius: 2,
    width: '100%',
  },
  fill: {
    height: 4,
    borderRadius: 2,
    position: 'absolute',
    left: 0,
    top: '50%',
    marginTop: -2,
  },
  thumb: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    position: 'absolute',
    top: '50%',
    marginTop: -10,
    marginLeft: -10,
    boxShadow: '0px 2px 3px 0px rgba(0, 0, 0, 0.2)',
    elevation: 3,
  },
});
