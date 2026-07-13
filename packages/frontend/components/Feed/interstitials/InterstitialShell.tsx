import React, { useCallback } from 'react';
import { Platform, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { PressableScale } from '@oxyhq/bloom/pressable-scale';
import { useTheme } from '@oxyhq/bloom/theme';
import { ThemedText } from '@/components/ThemedText';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';
import {
  INTERSTITIAL_CARD_GAP,
  INTERSTITIAL_CARD_WIDTH,
  INTERSTITIAL_EDGE_PADDING,
  INTERSTITIAL_SEE_MORE_CARD_WIDTH,
  INTERSTITIAL_SNAP_INTERVAL,
  type InterstitialLimits,
} from './interstitialLayout';

/**
 * The frame every recommendation band shares.
 *
 * One band, two layouts: a snapping horizontal carousel of fixed-width cards on
 * phones (where vertical space is the scarce resource and a swipe is cheap), a
 * vertical list of full-width rows on wider screens (where the feed column is
 * wide enough to read a row and a carousel would be a mouse-hostile gimmick).
 * The band itself is a distinct surface — its own background, closed by the
 * hairline every feed row already draws above it — so it reads as an aside and
 * never as a post.
 *
 * The shell owns the frame, the header, the "See more" affordance and the
 * responsive placement. It knows nothing about what is inside a card, which is
 * why all three kinds (users, feeds, starter packs) can share it.
 */

export interface InterstitialItemContext {
  /**
   * The item is a fixed-width card in the mobile carousel rather than a
   * full-width row. Items use it to drop the row chrome (dividers, insets) that
   * only makes sense in the vertical list.
   */
  isCarousel: boolean;
  /** Last item in the band — a row can drop its trailing divider. */
  isLast: boolean;
}

interface InterstitialShellProps<TItem> {
  title: string;
  /** Destination of the header link (desktop) and the trailing card (mobile). */
  seeMoreHref: Href;
  /** The suggestions to show. Empty while `isLoading`. */
  items: readonly TItem[];
  keyExtractor: (item: TItem) => string;
  renderItem: (item: TItem, context: InterstitialItemContext) => React.ReactElement;
  limits: InterstitialLimits;
  /** True until the suggestions land: placeholders stand in their place. */
  isLoading?: boolean;
  /** ONE placeholder item; the shell repeats it `limits.skeletonItems` times. */
  renderSkeleton?: () => React.ReactElement;
}

export function InterstitialShell<TItem>({
  title,
  seeMoreHref,
  items,
  keyExtractor,
  renderItem,
  limits,
  isLoading = false,
  renderSkeleton,
}: InterstitialShellProps<TItem>) {
  const { t } = useTranslation();
  const isDesktop = useIsScreenNotMobile();

  const handleSeeMore = useCallback(() => {
    router.push(seeMoreHref);
  }, [seeMoreHref]);

  const seeMoreLabel = t('feed.interstitial.seeMore');

  const skeletonKeys = Array.from({ length: limits.skeletonItems }, (_, index) => index);
  const showSkeleton = isLoading && renderSkeleton !== undefined;

  return (
    <View className="bg-secondary border-border w-full border-b">
      <View className="flex-row items-center justify-between px-3 pb-2 pt-3">
        <ThemedText className="text-base font-bold" numberOfLines={1}>
          {title}
        </ThemedText>
        {isDesktop && (
          <TouchableOpacity
            onPress={handleSeeMore}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.webCursor}
            accessibilityRole="link"
            accessibilityLabel={seeMoreLabel}>
            <ThemedText className="text-primary text-sm font-medium">{seeMoreLabel}</ThemedText>
          </TouchableOpacity>
        )}
      </View>

      {isDesktop ? (
        <View className="pb-2">
          {showSkeleton && renderSkeleton
            ? skeletonKeys.map((key) => (
                <View key={key}>{renderSkeleton()}</View>
              ))
            : items.map((item, index) => (
                <View key={keyExtractor(item)}>
                  {renderItem(item, { isCarousel: false, isLast: index === items.length - 1 })}
                </View>
              ))}
        </View>
      ) : showSkeleton && renderSkeleton ? (
        // Placeholders sit in a plain row, not a scroller: there is nothing to
        // swipe to yet, and a bouncing empty carousel reads as a broken one.
        <View style={styles.carouselContent} className="flex-row pb-3">
          {skeletonKeys.map((key) => (
            <View key={key} style={styles.card}>
              {renderSkeleton()}
            </View>
          ))}
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={INTERSTITIAL_SNAP_INTERVAL}
          snapToAlignment="start"
          decelerationRate="fast"
          contentContainerStyle={styles.carouselContent}
          className="pb-3">
          {items.map((item, index) => (
            <View key={keyExtractor(item)} style={styles.card}>
              {renderItem(item, { isCarousel: true, isLast: index === items.length - 1 })}
            </View>
          ))}
          <SeeMoreCard label={seeMoreLabel} onPress={handleSeeMore} />
        </ScrollView>
      )}
    </View>
  );
}

/**
 * The carousel's last card. Mobile has no room for a header link, so the way out
 * of the band to the full screen is the card you reach by swiping past the
 * suggestions — the same gesture you were already making.
 */
function SeeMoreCard({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();

  return (
    <View style={styles.seeMoreCard}>
      <PressableScale
        onPress={onPress}
        className="bg-surface border-border flex-1 items-center justify-center gap-2 rounded-xl border"
        accessibilityRole="button"
        accessibilityLabel={label}>
        <View className="bg-primary/10 h-9 w-9 items-center justify-center rounded-full">
          <Ionicons name="arrow-forward" size={18} color={theme.colors.primary} />
        </View>
        <ThemedText className="text-primary text-sm font-semibold">{label}</ThemedText>
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  carouselContent: {
    paddingHorizontal: INTERSTITIAL_EDGE_PADDING,
    gap: INTERSTITIAL_CARD_GAP,
  },
  card: {
    width: INTERSTITIAL_CARD_WIDTH,
  },
  seeMoreCard: {
    width: INTERSTITIAL_SEE_MORE_CARD_WIDTH,
  },
  webCursor: Platform.select({ web: { cursor: 'pointer' }, default: {} }),
});
