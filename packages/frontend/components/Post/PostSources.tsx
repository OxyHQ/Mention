import { tokens } from '@oxy.so/bloom/styles';
import type React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiLinksLine } from '@oxy.so/bloom/icons/RiLinksLine';
import type { PostSourceLink } from '@mention/shared-types';
import { openExternalLink } from '@/utils/openExternalLink';

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
  const { colors } = useTheme();
  if (!sources || sources.length === 0) {
    return null;
  }

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
            hitSlop={tokens.hitSlop.md}
            onPress={() => openExternalLink(source.url)}
          >
            <View className="w-8 h-8 rounded-full items-center justify-center bg-card">
              <RiLinksLine width={16} height={16} fill={colors.primary} />
            </View>
            <View className="flex-1">
              <Text className="text-foreground text-sm font-semibold" numberOfLines={2}>
                {title}
              </Text>
              <Text className="text-muted-foreground text-xs mt-0.5" numberOfLines={1}>
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
