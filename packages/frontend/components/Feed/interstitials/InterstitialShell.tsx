import { Button } from '@oxy.so/bloom/button';
import type React from 'react';
import { useCallback } from 'react';
import { StyleSheet } from 'react-native';
import { useRouter, type Href } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { Carousel, CarouselItem } from '@oxy.so/bloom/carousel';

import { RiArrowRightLine } from '@oxy.so/bloom/icons/RiArrowRightLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';
import {
  INTERSTITIAL_CARD_GAP,
  INTERSTITIAL_EDGE_PADDING,
  INTERSTITIAL_SEE_MORE_CARD_WIDTH,
  INTERSTITIAL_SKELETON_ITEMS,
} from './interstitialLayout';
import { useInterstitialImpression, type ReportInterstitialEvent } from './interstitialTelemetry';

import {
  Button as LButton,
  Embed,
  Icon,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

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
  /** Destination of the grouped header button (wide screens) and the trailing card. */
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
  const router = useRouter();
  const { t } = useTranslation();
  const isDesktop = useIsScreenNotMobile();

  const handleSeeMore = useCallback(() => {
    report('seeMore');
    router.push(seeMoreHref);
  }, [report, seeMoreHref, router]);

  const seeMoreLabel = t('feed.interstitial.seeMore');

  const showSkeleton = isLoading && renderSkeleton !== undefined;

  // A band still on placeholders has not been seen — it has nothing to show yet,
  // and it may still collapse to nothing once its suggestions land.
  const impressionRef = useInterstitialImpression(report, !isLoading && items.length > 0);

  const header = toElement(
    LText(title)
      .font('16')
      .leading('24px')
      .weight('bold')
      .foreground('foreground')
      .shrink('normal')
      .lines(1),
  );

  return toElement(
    // The band: its ref is the impression target.
    VStack(
      // Placeholders sit in the same carousel as the cards they stand in for, so
      // nothing shifts when the suggestions land; only the arrows and the
      // See-more card wait for real content.
      Embed(
        <Carousel
          accessibilityLabel={title}
          header={header}
          showArrows={isDesktop && !showSkeleton}
          renderControls={({ previous, next }) => (
            <Button.Group size="sm" accessibilityLabel={title}>
              {toElement(LButton(LText(seeMoreLabel)).onPress(handleSeeMore).label(seeMoreLabel))}
              {toElement(
                LButton(Icon(previous.icon))
                  .shape('circle')
                  .disabled(previous.disabled)
                  .label(previous.accessibilityLabel)
                  .onPress(previous.onPress),
              )}
              {toElement(
                LButton(Icon(next.icon))
                  .shape('circle')
                  .disabled(next.disabled)
                  .label(next.accessibilityLabel)
                  .onPress(next.onPress),
              )}
            </Button.Group>
          )}
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
        </Carousel>,
      ),
    )
      .padding('vertical', 'md')
      .frame({ width: 'full' })
      .background('mutedFill')
      .border('border', 'thin', 'bottom')
      .ref(impressionRef),
  );
}

/**
 * The carousel's last card. A phone has no room for the grouped header controls, so the way
 * out of the band to the full screen is the card you reach by swiping past the
 * suggestions — the same gesture you were already making.
 */
function SeeMoreCard({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();

  return toElement(
    VStack(
      VStack(Icon(RiArrowRightLine).size('18').foreground('primary'))
        .frame({ height: '36', width: '36' })
        .background('primary/10')
        .corner('infinite')
        .align('center')
        .justify('center'),
      LText(label).foreground('primary').font('14').leading('24px').weight('semibold'),
    )
      .background('surface')
      .border('border', 'thin')
      .corner('md')
      .flex('1')
      .align('center')
      .justify('center')
      .spacing('sm')
      .onPress(onPress)
      .role('button')
      .label(label)
      .pressScale(),
  );
}

const styles = StyleSheet.create({
  // Title row to cards — tighter than Bloom's gallery default of 16.
  carousel: {
    gap: 12,
  },
});
