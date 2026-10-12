import React, { useMemo } from 'react';
import { Text, StyleSheet, StyleProp, TextStyle } from 'react-native';
import { Link, type Href } from 'expo-router';
import { getNormalizedUserHandle } from '@oxy.so/core';
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

/**
 * A click on an in-app link stops at the link: this text usually sits inside a
 * pressable post row, which would otherwise open the post as well.
 */
function stopAtLink(event: { stopPropagation(): void }): void {
  event.stopPropagation();
}

/**
 * `rel="nofollow"` on the web anchor, for a profile link nobody has verified
 * (see `LinkifyEntity.unverified`). Set on the `Text` itself: `Link asChild`
 * hands its own `rel` to the child as a bare prop, and react-native-web writes
 * only `hrefAttrs.rel` to the `<a>`. Native ignores it.
 */
const NOFOLLOW = { hrefAttrs: { rel: 'nofollow' } } as object;

// Renders text with clickable @mentions, #hashtags, $cashtags, and URLs.
// In-app destinations are expo-router `Link`s — on web, real `<a href>`s that
// a crawler follows and a reader can open in a new tab.
export const LinkifiedText: React.FC<LinkifiedTextProps> = ({
  text,
  style,
  className,
  linkStyle,
  suffix,
  numberOfLines,
  linkTargetText,
}) => {
  const nodes = useMemo(() => {
    if (!text) return null;

    // Flattened: a `Link asChild` merges its own props into the link's `Text`,
    // and that merge cannot take a style array.
    const flatLinkStyle = StyleSheet.flatten(linkStyle);
    const linkText = (
      href: Href,
      label: React.ReactNode,
      linkKey?: string,
      unverified?: boolean,
    ) => (
      <Link key={linkKey} href={href} push asChild onPress={stopAtLink}>
        <Text className="text-primary" style={flatLinkStyle} {...(unverified ? NOFOLLOW : null)}>
          {label}
        </Text>
      </Link>
    );

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

      if (entity.kind === 'mentionDisplay' && /^https?:\/\//i.test(entity.value)) {
        // Inbound federation keeps an unresolved mention's actual source href.
        // It is a link to that remote profile, not a local identity or hover card.
        elements.push(
          <Text
            key={`m-${key++}`}
            className="text-primary"
            style={linkStyle}
            accessibilityRole="link"
            onPress={(event) => {
              event.stopPropagation();
              openExternalLink(entity.value);
            }}
          >
            {entity.label}
          </Text>,
        );
      } else if (entity.kind === 'mentionDisplay') {
        // One handle drives both behaviors — the profile link and the hover
        // preview — so they can never point at different profiles.
        const mentionHandle = getNormalizedUserHandle({ username: entity.value }) ?? undefined;
        elements.push(
          <ProfileHoverCard key={`m-${key++}`} username={mentionHandle}>
            {mentionHandle ? (
              linkText(`/@${mentionHandle}`, entity.label, undefined, entity.unverified)
            ) : (
              <Text className="text-primary" style={linkStyle}>
                {entity.label}
              </Text>
            )}
          </ProfileHoverCard>,
        );
      } else if (entity.kind === 'federatedHandle') {
        // The handle already names its host, so it routes verbatim — no
        // normalization, and nothing inferred about which instance it is on.
        elements.push(
          <ProfileHoverCard key={`f-${key++}`} username={entity.value}>
            {linkText(`/@${entity.value}`, entity.raw, undefined, entity.unverified)}
          </ProfileHoverCard>,
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
          </Text>,
        );
        // Punctuation that merely trailed the URL belongs to the sentence.
        pushText(trailing);
      } else if (entity.kind === 'hashtag') {
        elements.push(
          linkText(`/hashtag/${encodeURIComponent(entity.value)}`, entity.raw, `h-${key++}`),
        );
      } else if (entity.kind === 'cashtag') {
        elements.push(
          linkText(`/search/${encodeURIComponent(`$${entity.value}`)}`, entity.raw, `c-${key++}`),
        );
      }
    }

    pushText(text.slice(lastIndex));
    return elements;
  }, [text, linkStyle, linkTargetText]);

  if (!text) return null;
  return (
    <Text style={style} className={className} numberOfLines={numberOfLines}>
      {nodes}
      {suffix}
    </Text>
  );
};

export default LinkifiedText;
