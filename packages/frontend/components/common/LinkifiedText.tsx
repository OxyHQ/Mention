import React, { useMemo } from 'react';
import { Text, StyleProp, TextStyle, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { colors } from '@/styles/colors';

interface LinkifiedTextProps {
  text: string;
  style?: StyleProp<TextStyle>;
  linkStyle?: StyleProp<TextStyle>;
  suffix?: React.ReactNode;
}

// Renders text with clickable @mentions, #hashtags, $cashtags, and URLs
export const LinkifiedText: React.FC<LinkifiedTextProps> = ({ text, style, linkStyle, suffix }) => {
  const router = useRouter();
  const nodes = useMemo(() => {
    if (!text) return null;

    const elements: React.ReactNode[] = [];

    // 1) URLs: http(s)://... or www....
    // 2) Entities with preceding boundary capture to avoid emails/usernames: mentions, hashtags, cashtags
    const pattern = /(https?:\/\/[^\s]+|www\.[^\s]+)|(^|[^A-Za-z0-9_])(@[A-Za-z0-9_]{1,30}|#[A-Za-z][A-Za-z0-9_]*|\$[A-Z]{1,6}(?:\.[A-Z]{1,2})?)/g;

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
      const urlCandidate = match[1];
      const boundary = match[2] ?? '';
      const entity = match[3];

      if (urlCandidate) {
        const start = match.index;
        pushText(text.slice(lastIndex, start));

        const { url, trailing } = trimUrlTrailingPunct(urlCandidate);
        const href = url.startsWith('http') ? url : `https://${url}`;
        elements.push(
          <Text
            key={`u-${key++}`}
            style={[{ color: colors.linkColor }, linkStyle]}
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

        if (entity.startsWith('@')) {
          const handle = entity.slice(1);
          elements.push(
            <Text
              key={`m-${key++}`}
              style={[{ color: colors.linkColor }, linkStyle]}
              onPress={() => router.push(`/@${handle}`)}
            >
              {entity}
            </Text>
          );
        } else if (entity.startsWith('#')) {
          const tag = entity.slice(1);
          const q = encodeURIComponent(`#${tag}`);
          elements.push(
            <Text
              key={`h-${key++}`}
              style={[{ color: colors.linkColor }, linkStyle]}
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
              style={[{ color: colors.linkColor }, linkStyle]}
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
  }, [text, linkStyle, router]);

  if (!text) return null;
  return <Text style={style}>{nodes}{suffix}</Text>;
};

export default LinkifiedText;
