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
    <View style={[styles.container, { paddingLeft: leftOffset, paddingRight: 16 }]}>
      {sources.map((source, index) => {
        if (!source?.url) return null;
        const title = source.title?.trim() || getHostname(source.url);
        const hostname = getHostname(source.url);

        return (
          <TouchableOpacity
            key={`${source.url}-${index}`}
            style={[
              styles.item,
              {
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.backgroundSecondary,
              },
            ]}
            activeOpacity={0.85}
            onPress={() => openSource(source.url)}
          >
            <View style={[styles.iconWrapper, { backgroundColor: theme.colors.card }]}> 
              <SourcesIcon size={16} color={theme.colors.primary} />
            </View>
            <View style={styles.textWrapper}>
              <Text
                style={[styles.title, { color: theme.colors.text }]}
                numberOfLines={2}
              >
                {title}
              </Text>
              <Text
                style={[styles.subtitle, { color: theme.colors.textSecondary }]}
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

const styles = StyleSheet.create({
  container: {
    gap: 8,
    marginTop: 8,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 12,
  },
  iconWrapper: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textWrapper: {
    flex: 1,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 12,
    marginTop: 2,
  },
});

export default PostSources;

