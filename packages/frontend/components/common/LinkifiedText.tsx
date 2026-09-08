import React, { useMemo } from 'react';
import { Text, StyleProp, TextStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { ProfileHoverCard } from '@/components/ProfileHoverCard';
import {
  scanTextEntities,
  toOpenableUrl,
  trimUrlTrailingPunctuation,
} from '@mention/shared-types/textEntities';
import { scanLinkifyEntities } from '@/utils/linkifyPattern';
import { openExternalLink } from '@/utils/openExternalLink';

interface LinkifiedTextProps {
  text: string;
  style?: StyleProp<TextStyle>;
  className?: string;
  linkStyle?: StyleProp<TextStyle>;
  suffix?: React.ReactNode;
  /** Clamp the rendered text to N lines (forwarded to the root <Text>). */
  numberOfLines?: number;
  /**
   * Full source text for link destinations when `text` is a truncated prefix.
   * Labels still come from `text`; a URL beginning at the same character offset
   * opens the complete source URL instead of the visibly cut prefix.
   */
  linkTargetText?: string;
}

// Renders text with clickable @mentions, #hashtags, $cashtags, and URLs
export const LinkifiedText: React.FC<LinkifiedTextProps> = ({ text, style, className, linkStyle, suffix, numberOfLines, linkTargetText }) => {
  const router = useRouter();
  const nodes = useMemo(() => {
    if (!text) return null;

    const elements: React.ReactNode[] = [];
    const fullUrlByStart = new Map<number, string>();
    if (linkTargetText && linkTargetText !== text) {
      for (const entity of scanTextEntities(linkTargetText, { kinds: ['url'] })) {
        fullUrlByStart.set(entity.start, trimUrlTrailingPunctuation(entity.value).url);
      }
    }

    let lastIndex = 0;
    let key = 0;

    // Plain prose goes in as a STRING, not a styleless <Text>. The root <Text>
    // below already carries every style this run would inherit, so the wrapper
    // drew nothing — and under NativeWind's global class-name polyfill each one
    // is a `react-native-css` interop component (two useContext, two useState,
    // an effect and a rule evaluation) plus its own host text node. Every post
    // with a body paid at least one; a post with N entities paid up to N+1.
    // Strings in a children array need no key, so nothing else changes.
    const pushText = (t: string) => {
      if (!t) return;
      elements.push(t);
    };

    for (const entity of scanLinkifyEntities(text)) {
      // Everything between the previous entity and this one is plain prose.
      pushText(text.slice(lastIndex, entity.start));
      lastIndex = entity.end;

      if (entity.kind === 'mentionDisplay') {
        // One handle drives both behaviors — the profile link and the hover
        // preview — so they can never point at different profiles. `inline`
        // keeps the mention in the text flow instead of breaking the line.
        const mentionHandle = getNormalizedUserHandle({ username: entity.value }) ?? undefined;
        elements.push(
          <ProfileHoverCard key={`m-${key++}`} username={mentionHandle} inline>
            <Text
              className="text-primary"
              style={linkStyle}
              onPress={mentionHandle ? () => router.push(`/@${mentionHandle}`) : undefined}
            >
              {entity.label}
            </Text>
          </ProfileHoverCard>
        );
      } else if (entity.kind === 'federatedHandle') {
        // The handle already names its host, so it routes verbatim — no
        // normalization, and nothing inferred about which instance it is on.
        elements.push(
          <ProfileHoverCard key={`f-${key++}`} username={entity.value} inline>
            <Text
              className="text-primary"
              style={linkStyle}
              onPress={() => router.push(`/@${entity.value}`)}
            >
              {entity.raw}
            </Text>
          </ProfileHoverCard>
        );
      } else if (entity.kind === 'url') {
        const { url, trailing } = trimUrlTrailingPunctuation(entity.value);
        const href = toOpenableUrl(fullUrlByStart.get(entity.start) ?? url);
        elements.push(
          <Text
            key={`u-${key++}`}
            className="text-primary"
            style={linkStyle}
            onPress={() => openExternalLink(href)}
          >
            {url}
          </Text>
        );
        // Punctuation that merely trailed the URL belongs to the sentence.
        pushText(trailing);
      } else if (entity.kind === 'hashtag') {
        elements.push(
          <Text
            key={`h-${key++}`}
            className="text-primary"
            style={linkStyle}
            onPress={() => router.push(`/hashtag/${encodeURIComponent(entity.value)}`)}
          >
            {entity.raw}
          </Text>
        );
      } else if (entity.kind === 'cashtag') {
        const q = encodeURIComponent(`$${entity.value}`);
        elements.push(
          <Text
            key={`c-${key++}`}
            className="text-primary"
            style={linkStyle}
            onPress={() => router.push(`/search/${q}`)}
          >
            {entity.raw}
          </Text>
        );
      }
    }

    pushText(text.slice(lastIndex));
    return elements;
  }, [text, linkStyle, linkTargetText, router]);

  if (!text) return null;
  return <Text style={style} className={className} numberOfLines={numberOfLines}>{nodes}{suffix}</Text>;
};

export default LinkifiedText;
