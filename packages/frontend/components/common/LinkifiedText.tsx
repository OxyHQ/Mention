import React, { useMemo } from 'react';
import { Text, StyleProp, TextStyle, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';

interface LinkifiedTextProps {
  text: string;
  style?: StyleProp<TextStyle>;
  linkStyle?: StyleProp<TextStyle>;
  suffix?: React.ReactNode;
}

// Renders text with clickable @mentions, #hashtags, $cashtags, and URLs
export const LinkifiedText: React.FC<LinkifiedTextProps> = ({ text, style, linkStyle, suffix }) => {
  const router = useRouter();
  const theme = useTheme();
  const nodes = useMemo(() => {
    if (!text) return null;

    const elements: React.ReactNode[] = [];

    // 1) Mentions in format [@DisplayName](username) - from backend
    // 2) URLs: http(s)://... or www....
    // 3) Entities with preceding boundary capture: hashtags, cashtags
    const pattern = /(\[@([^\]]+)\]\(([^)]+)\))|(https?:\/\/[^\s]+|www\.[^\s]+)|(^|[^A-Za-z0-9_])(#[A-Za-z][A-Za-z0-9_]*|\$[A-Z]{1,6}(?:\.[A-Z]{1,2})?)/g;

    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let key = 0;

    const pushText = (t: string) => {
      if (!t) return;
      elements.push(<Text key={`t-${key++}`}>{t}</Text>);
    };

    const trimUrlTrailingPunct = (raw: string) => {
      let url = raw;
      let trailing = '';
      while (/[.,!?):;\]]$/.test(url)) {
        trailing = url.slice(-1) + trailing;
        url = url.slice(0, -1);
      }
      return { url, trailing };
    };

    while ((match = pattern.exec(text)) !== null) {
      const full = match[0];
      const mentionFull = match[1];      // [@DisplayName](username)
      const mentionDisplay = match[2];   // DisplayName
      const mentionUsername = match[3];  // username
      const urlCandidate = match[4];
      const boundary = match[5] ?? '';
      const entity = match[6];

      if (mentionFull) {
        // Handle mention: display "DisplayName" (without @) but make it clickable
        const start = match.index;
        pushText(text.slice(lastIndex, start));

        elements.push(
          <Text
            key={`m-${key++}`}
            style={[{ color: theme.colors.primary }, linkStyle]}
            onPress={() => router.push(`/@${mentionUsername}`)}
          >
            {mentionDisplay}
          </Text>
        );
        lastIndex = start + full.length;
      } else if (urlCandidate) {
        const start = match.index;
        pushText(text.slice(lastIndex, start));

        const { url, trailing } = trimUrlTrailingPunct(urlCandidate);
        const href = url.startsWith('http') ? url : `https://${url}`;
        elements.push(
          <Text
            key={`u-${key++}`}
            style={[{ color: theme.colors.primary }, linkStyle]}
            onPress={() => Linking.openURL(href)}
          >
            {url}
          </Text>
        );
        pushText(trailing);
        lastIndex = start + full.length;
      } else if (entity) {
        const entityStart = match.index + boundary.length;
        pushText(text.slice(lastIndex, match.index));
        pushText(boundary);

        if (entity.startsWith('#')) {
          const tag = entity.slice(1);
          const q = encodeURIComponent(`#${tag}`);
          elements.push(
            <Text
              key={`h-${key++}`}
              style={[{ color: theme.colors.primary }, linkStyle]}
              onPress={() => router.push(`/search/${q}`)}
            >
              {entity}
            </Text>
          );
        } else if (entity.startsWith('$')) {
          const symbol = entity.slice(1);
          const q = encodeURIComponent(`$${symbol}`);
          elements.push(
            <Text
              key={`c-${key++}`}
              style={[{ color: theme.colors.primary }, linkStyle]}
              onPress={() => router.push(`/search/${q}`)}
            >
              {entity}
            </Text>
          );
        } else {
          pushText(entity);
        }

        lastIndex = entityStart + entity.length;
      }
    }

    pushText(text.slice(lastIndex));
    return elements;
  }, [text, linkStyle, router, theme.colors.primary]);

  if (!text) return null;
  return <Text style={style}>{nodes}{suffix}</Text>;
};

export default LinkifiedText;
