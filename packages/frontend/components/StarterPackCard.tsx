import React from 'react';
import { View, StyleSheet } from 'react-native';
import { PressableScale } from '@/lib/animations/PressableScale';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { ThemedText } from './ThemedText';

export interface StarterPackCardData {
  id: string;
  name: string;
  description?: string;
  creator?: {
    username: string;
    displayName?: string;
    avatar?: string;
  };
  memberCount: number;
  useCount: number;
}

interface StarterPackCardProps {
  pack: StarterPackCardData;
  onPress?: () => void;
}

export function StarterPackCard({ pack, onPress }: StarterPackCardProps) {
  const theme = useTheme();

  return (
    <PressableScale
      onPress={onPress}
      className="bg-card border-border"
      style={styles.outer}>
      <View style={styles.header}>
        <View className="bg-primary/20" style={styles.iconBubble}>
          <Ionicons name="rocket-outline" size={22} color={theme.colors.primary} />
        </View>
        <View style={styles.titleContainer}>
          <ThemedText style={styles.title} numberOfLines={1}>
            {pack.name}
          </ThemedText>
          {pack.creator && (
            <ThemedText
              className="text-muted-foreground"
              style={styles.byline}
              numberOfLines={1}>
              Starter pack by @{pack.creator.username}
            </ThemedText>
          )}
        </View>
      </View>
      {pack.description && (
        <ThemedText
          className="text-muted-foreground"
          style={styles.descriptionText}
          numberOfLines={3}>
          {pack.description}
        </ThemedText>
      )}
      <ThemedText className="text-muted-foreground" style={styles.stats}>
        {pack.memberCount} {pack.memberCount === 1 ? 'account' : 'accounts'}
        {pack.useCount > 0 ? ` · Used by ${pack.useCount} ${pack.useCount === 1 ? 'person' : 'people'}` : ''}
      </ThemedText>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  outer: {
    width: '100%',
    padding: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconBubble: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleContainer: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 20,
  },
  byline: {
    fontSize: 14,
    lineHeight: 18,
  },
  descriptionText: {
    fontSize: 14,
    lineHeight: 20,
  },
  stats: {
    fontSize: 13,
    fontWeight: '500',
  },
});
