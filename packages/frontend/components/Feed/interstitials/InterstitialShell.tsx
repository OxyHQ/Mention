import React, { useCallback } from 'react';
import { Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Carousel, CarouselItem } from '@oxy.so/bloom/carousel';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { RiArrowRightLine } from '@oxy.so/bloom/icons/RiArrowRightLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';
import {
  INTERSTITIAL_CARD_GAP,
  INTERSTITIAL_EDGE_PADDING,
  INTERSTITIAL_SEE_MORE_CARD_WIDTH,
  INTERSTITIAL_SKELETON_ITEMS,
} from './interstitialLayout';
import { useInterstitialImpression, type ReportInterstitialEvent } from './interstitialTelemetry';
import { HIT_SLOP_MD } from '@/styles/hitSlop';

/**
 * The frame every recommendation band shares.
 *
 * One layout on every screen: a horizontal carousel of fixed-width cards —
 * Bloom's `Carousel`, the same row X and Instagram put between posts. On a
 * phone it is swiped; on a wide screen the arrows sit beside the title, because
 * a mouse cannot swipe. The band itself is a distinct surface — its own
 * background, closed by the hairline every feed row already draws above it — so
 * it reads as an aside and never as a post.
 *
 * The shell owns the frame, the header, the "See more" affordance and the card
 * width. It knows nothing about what is inside a card, which is why every kind
 * (people, feeds, starter packs, trends) can share it.
 */

interface InterstitialShellProps<TItem> {
  title: string;
  /** Destination of the header link (wide screens) and the trailing card. */
  seeMoreHref: Href;
  /** The suggestions to show. Empty while `isLoading`. */
  items: readonly TItem[];
  keyExtractor: (item: TItem) => string;
  /** Width of one card, from `INTERSTITIAL_CARD_WIDTH`. */
  cardWidth: number;
  /** `position` is the 0-based index within the band — on every item-level event. */
  renderItem: (item: TItem, position: number) => React.ReactElement;
  /** True until the suggestions land: placeholders stand in their place. */
  isLoading?: boolean;
  /** ONE placeholder item; the shell repeats it as many times as will be seen. */
  renderSkeleton?: () => React.ReactElement;
  /**
   * The band's bound reporter. The shell owns the two CARD-level events — the
   * impression (it renders the element visibility is measured on) and "See more"
   * (it renders both ways out of the band) — so no band can forget them; the
   * bands themselves report only what happens to an individual suggestion.
   */
  report: ReportInterstitialEvent;
}

export function InterstitialShell<TItem>({
  title,
  seeMoreHref,
  items,
  keyExtractor,
  cardWidth,
  renderItem,
  isLoading = false,
  renderSkeleton,
  report,
}: InterstitialShellProps<TItem>) {
  const { t } = useTranslation();
  const isDesktop = useIsScreenNotMobile();

  const handleSeeMore = useCallback(() => {
    report('seeMore');
    router.push(seeMoreHref);
  }, [report, seeMoreHref]);

  const seeMoreLabel = t('feed.interstitial.seeMore');

  const showSkeleton = isLoading && renderSkeleton !== undefined;

  // A band still on placeholders has not been seen — it has nothing to show yet,
  // and it may still collapse to nothing once its suggestions land.
  const impressionRef = useInterstitialImpression(report, !isLoading && items.length > 0);

  const header = (
    <View className="flex-row items-center gap-3">
      <Text className="text-base leading-6 font-bold text-foreground flex-shrink" numberOfLines={1}>
        {title}
      </Text>
      {isDesktop && (
        <TouchableOpacity
          onPress={handleSeeMore}
          activeOpacity={0.7}
          hitSlop={HIT_SLOP_MD}
          style={styles.webCursor}
          accessibilityRole="link"
          accessibilityLabel={seeMoreLabel}
        >
          <Text className="text-primary text-sm leading-6 font-medium">{seeMoreLabel}</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  return (
    <View ref={impressionRef} className="bg-muted border-border w-full border-b pb-3 pt-3">
      {/* Placeholders sit in the same carousel as the cards they stand in for, so
          nothing shifts when the suggestions land; only the arrows and the
          See-more card wait for real content. */}
      <Carousel
        accessibilityLabel={title}
        header={header}
        showArrows={isDesktop && !showSkeleton}
        showDots={false}
        gap={INTERSTITIAL_CARD_GAP}
        inset={INTERSTITIAL_EDGE_PADDING}
        previousLabel={t('feed.interstitial.previous')}
        nextLabel={t('feed.interstitial.next')}
        style={styles.carousel}
      >
        {showSkeleton && renderSkeleton
          ? Array.from(
              { length: INTERSTITIAL_SKELETON_ITEMS[isDesktop ? 'desktop' : 'mobile'] },
              (_, index) => (
                <CarouselItem key={index} width={cardWidth}>
                  {renderSkeleton()}
                </CarouselItem>
              ),
            )
          : [
              ...items.map((item, index) => (
                <CarouselItem key={keyExtractor(item)} width={cardWidth}>
                  {renderItem(item, index)}
                </CarouselItem>
              )),
              <CarouselItem
                key="see-more"
                width={INTERSTITIAL_SEE_MORE_CARD_WIDTH}
                accessibilityLabel={seeMoreLabel}
              >
                <SeeMoreCard label={seeMoreLabel} onPress={handleSeeMore} />
              </CarouselItem>,
            ]}
      </Carousel>
    </View>
  );
}

/**
 * The carousel's last card. A phone has no room for a header link, so the way
 * out of the band to the full screen is the card you reach by swiping past the
 * suggestions — the same gesture you were already making.
 */
function SeeMoreCard({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();

  return (
    <PressableScale
      onPress={onPress}
      className="bg-surface border-border flex-1 items-center justify-center gap-2 rounded-xl border"
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View className="bg-primary/10 h-9 w-9 items-center justify-center rounded-full">
        <RiArrowRightLine width={18} height={18} fill={theme.colors.primary} />
      </View>
      <Text className="text-primary text-sm leading-6 font-semibold">{label}</Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  // Title row to cards — tighter than Bloom's gallery default of 16.
  carousel: {
    gap: 12,
  },
  webCursor: Platform.select({ web: { cursor: 'pointer' }, default: {} }),
});
