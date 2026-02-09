import React, { memo, useState, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import Animated, {
  useAnimatedStyle,
  interpolate,
  Extrapolation,
  type SharedValue,
} from 'react-native-reanimated';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { useTheme } from '@/hooks/useTheme';
import { INTEREST_TOPICS } from './constants';
import type { OnboardingPageProps } from './types';

const InterestsPage: React.FC<OnboardingPageProps> = ({
  step,
  index,
  scrollProgress,
  pageWidth,
  reduceMotion,
}) => {
  const theme = useTheme();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleTopic = useCallback((label: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }, []);

  const containerStyle = useAnimatedStyle(() => {
    const progress = scrollProgress.value;
    const opacity = interpolate(
      progress,
      [index - 0.6, index, index + 0.6],
      [0, 1, 0],
      Extrapolation.CLAMP,
    );

    if (reduceMotion) {
      return { opacity };
    }

    const translateX = interpolate(
      progress,
      [index - 1, index, index + 1],
      [pageWidth * 0.1, 0, -pageWidth * 0.1],
      Extrapolation.CLAMP,
    );

    return {
      opacity,
      transform: [{ translateX }],
    };
  });

  return (
    <View style={[styles.page, { width: pageWidth }]}>
      <Animated.View style={[styles.content, containerStyle]}>
        <Text style={[styles.title, { color: theme.colors.text }]}>
          {step.title}
        </Text>
        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
          {step.subtitle}
        </Text>

        <View style={styles.chipsContainer}>
          {INTEREST_TOPICS.map((topic) => {
            const isSelected = selected.has(topic.label);
            return (
              <Pressable
                key={topic.label}
                onPress={() => toggleTopic(topic.label)}
                style={[
                  styles.chip,
                  {
                    backgroundColor: isSelected
                      ? theme.colors.primary
                      : theme.colors.backgroundSecondary,
                    borderColor: isSelected
                      ? theme.colors.primary
                      : theme.colors.border,
                  },
                ]}
              >
                <Text style={styles.chipEmoji}>{topic.emoji}</Text>
                <Text
                  style={[
                    styles.chipLabel,
                    { color: isSelected ? '#FFFFFF' : theme.colors.text },
                  ]}
                >
                  {topic.label}
                </Text>
                <MaterialCommunityIcons
                  name={isSelected ? 'check' : 'plus'}
                  size={14}
                  color={isSelected ? '#FFFFFF' : theme.colors.textSecondary}
                />
              </Pressable>
            );
          })}
        </View>
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  page: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 48,
  },
  content: {
    flex: 1,
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
    paddingHorizontal: 16,
  },
  chipsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 22,
    borderWidth: 1,
    gap: 6,
  },
  chipEmoji: {
    fontSize: 16,
  },
  chipLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
});

export default memo(InterestsPage);
