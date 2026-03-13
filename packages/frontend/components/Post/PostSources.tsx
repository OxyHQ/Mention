import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Linking } from 'react-native';
import { SourcesIcon } from '@/assets/icons/sources-icon';
import { useTheme } from '@/hooks/useTheme';
import { PostSourceLink } from '@mention/shared-types';

interface Props {
  sources?: PostSourceLink[];
  leftOffset?: number;
}

const getHostname = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const PostSources: React.FC<Props> = ({ sources, leftOffset = 0 }) => {
  const theme = useTheme();

  if (!sources || sources.length === 0) {
    return null;
  }

  const openSource = async (url: string) => {
    try {
      const supported = await Linking.canOpenURL(url);
      if (!supported) {
        console.warn('[PostSources] Cannot open URL:', url);
        return;
      }
      await Linking.openURL(url);
    } catch (error) {
      console.error('[PostSources] Failed to open URL:', url, error);
    }
  };

  return (
    <View className="gap-2 mt-2" style={{ paddingLeft: leftOffset, paddingRight: 16 }}>
      {sources.map((source, index) => {
        if (!source?.url) return null;
        const title = source.title?.trim() || getHostname(source.url);
        const hostname = getHostname(source.url);

        return (
          <TouchableOpacity
            key={`${source.url}-${index}`}
            className="flex-row items-center border border-border bg-surface rounded-xl py-2.5 px-3 gap-3"
            activeOpacity={0.85}
            onPress={() => openSource(source.url)}
          >
            <View className="w-8 h-8 rounded-full items-center justify-center bg-card">
              <SourcesIcon size={16} color={theme.colors.primary} />
            </View>
            <View className="flex-1">
              <Text
                className="text-foreground text-sm font-semibold"
                numberOfLines={2}
              >
                {title}
              </Text>
              <Text
                className="text-muted-foreground text-xs mt-0.5"
                numberOfLines={1}
              >
                {hostname}
              </Text>
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

export default PostSources;
