import { memo } from 'react';
import type { ViewStyle } from 'react-native';
import { useContentSafeAreaInsets } from '@oxy.so/bloom/layout';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { CoverHeader } from '@oxy.so/bloom/cover-header';
import { useSurfaceFill } from '@oxy.so/bloom/styles';
import { FeedSkeleton } from '@/components/loading/ContentSkeleton';
import { CHANNEL_AVATAR_SIZE } from './ChannelHeader';
import {
  PROFILE_AVATAR_OVERLAP,
  PROFILE_AVATAR_RING,
  PROFILE_BANNER_HEIGHT,
} from './ProfilePageHeader';
import { LAYOUT } from './types';

import {
  Embed,
  HStack,
  VStack,
  toElement,
  Embed as LEmbed,
  HStack as LHStack,
  toElement as LtoElement,
} from '@oxy.so/bloom-language';

/**
 * Loading skeleton for the profile screen.
 *
 * Mirrors the loaded profile anatomy element-for-element so the swap to real
 * data produces no layout shift:
 *  - the banner and the avatar row rising into it, through the SAME Bloom
 *    `CoverHeader` and the same two measurements `ProfileShell` uses, so the
 *    avatar (90px, 3px background ring) lands at its identical final Y — with
 *    a placeholder action row (button + icon) on the right;
 *  - display-name + handle bars, a 2-line bio, the meta row and the stats row
 *    (mirroring ProfileContent → ProfileMeta / ProfileStats);
 *  - the tab bar (matching the Bloom Tabs strip's border + `py-2.5` cells); and
 *  - a few post-row placeholders matching the feed's POST_ITEM_SPACING.
 *
 * All blocks use Bloom's shimmer primitives (theme-aware `contrast50` fill +
 * a self-driven opacity loop) so it stays consistent with the app's other
 * skeletons (feed / notifications / cards).
 */

// The header avatar's footprint (mirrors ProfileHeader).
const AVATAR_SIZE = 90;
// A channel's avatar overlaps no banner; its ring stays ChannelHeader's 3px.
const CHANNEL_AVATAR_RING = 3;
// Representative widths for the five stat clusters (following / followers /
// posts / boosts / replies) and the profile tab labels.
const STAT_CHIP_WIDTHS = [96, 104, 78, 84, 90];
const TAB_CHIP_WIDTHS = [42, 54, 50, 58, 44, 56];
const FEED_ROW_COUNT = 4;

// The rows' boxes, as their classes drew them (plain objects: they are inline, as the classes were).
const FULL_WIDTH: ViewStyle = { width: '100%' };
/** The meta row: wraps, 16pt between items, 4pt between lines, 12pt under it. */
const META_ROW: ViewStyle = {
  flexDirection: 'row',
  flexWrap: 'wrap',
  marginBottom: 12,
  columnGap: 16,
  rowGap: 4,
};
/** The stats row: wraps, 16pt between items, 8pt between lines. */
const STATS_ROW: ViewStyle = { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 8 };

// A CHANNEL's anatomy, which is a different shape rather than a smaller one: no
// banner to overlap, a CENTRED masthead (avatar, then name, then handle, then
// the follow control), four stats (no replies — a channel can author none) and
// four tabs. Mirrors `ChannelHeader` + `useProfileChrome({ hasBannerBand:
// false })`.
//
// The avatar size is IMPORTED rather than restated: it is the one measurement
// where a disagreement between this file and the header is a visible jump at
// the moment the data lands.
const CHANNEL_CONTENT_OFFSET = 60;
const CHANNEL_STAT_CHIP_WIDTHS = [96, 104, 78, 84];
const CHANNEL_TAB_CHIP_WIDTHS = [42, 50, 58, 56];

export interface ProfileSkeletonProps {
  /**
   * Which anatomy to mirror. A skeleton exists to hold the exact space the real
   * content will occupy, so drawing a person's banner and 90px overlapping
   * avatar in front of a channel is not a cosmetic mismatch — it is a layout
   * shift at the moment the data lands, which is the one thing a skeleton is
   * for.
   */
  variant?: 'person' | 'channel';
}

export const ProfileSkeleton = memo(function ProfileSkeleton({
  variant = 'person',
}: ProfileSkeletonProps = {}) {
  const insets = useContentSafeAreaInsets();
  // The avatar ring is the colour of the surface under it, as on the loaded profile.
  const surfaceFill = useSurfaceFill();
  // Mirrors the loaded profile: the same opaque blocks, in the same colour as
  // the column they land in (see ProfileContent / ProfileTabBarRow).

  if (variant === 'channel') {
    return (
      <Skeleton.Region style={FULL_WIDTH}>
        {LtoElement(
          VStack(
            VStack(
              /* Centred masthead — avatar, then name, then handle. The margins
                      are `ChannelHeader`'s own: the name Text carries `marginTop: 12,
                      marginBottom: 4` and the handle sits straight under it, so the
                      placeholders repeat those as `mt-3` / `mb-1` rather than a
                      rhythm of their own.
                      Each bar is drawn SHORTER than the line it stands in — a
                      full-height slab reads as a block, not a line — so it is centred
                      inside a wrapper of the line's TRUE height: `h-7` (28px) for the
                      24px display name, `h-5` (20px) for the 15px/20 handle. Measured
                      in a browser: without the wrappers the masthead came out 12px
                      short and everything below it, the follow control and the tab
                      strip included, sat 12px high and jumped when the data landed —
                      which is the exact defect a skeleton exists to prevent. */ VStack(
                Embed(
                  <Skeleton.Circle
                    size={CHANNEL_AVATAR_SIZE}
                    style={{ borderWidth: CHANNEL_AVATAR_RING, borderColor: surfaceFill }}
                  />,
                ),
                VStack(Embed(<Skeleton.Box width={180} height={22} borderRadius={6} />))
                  .frame({ height: '28' })
                  .margin('top', 'md')
                  .margin('bottom', 'xs')
                  .justify('center'),
                VStack(Embed(<Skeleton.Box width={110} height={14} borderRadius={6} />))
                  .frame({ height: 'xl' })
                  .justify('center'),
              )
                .frame({ width: 'full' })
                .align('center'),
              /* Follow button — the whole action row, and the last element of the
                      centred masthead; a channel has no poke and no self view. */ HStack(
                Embed(<Skeleton.Box width={92} height={36} borderRadius={999} />),
              )
                .margin('top', 'lg')
                .margin('bottom', 'lg')
                .justify('center'),
              VStack(
                Embed(<Skeleton.Box width="92%" height={14} borderRadius={6} />),
                Embed(<Skeleton.Box width="78%" height={14} borderRadius={6} />),
              )
                .margin('bottom', 'md')
                .spacing('sm'),
              Embed(
                LtoElement(
                  LHStack(
                    LEmbed(<Skeleton.Box width={110} height={15} borderRadius={6} />),
                    LEmbed(<Skeleton.Box width={150} height={15} borderRadius={6} />),
                  )
                    .wrap()
                    .margin('bottom', 'md')
                    .horizontalSpacing('lg')
                    .verticalSpacing('xs'),
                ),
              ),
              Embed(
                LtoElement(
                  LHStack(
                    LEmbed(
                      CHANNEL_STAT_CHIP_WIDTHS.map((width, index) => (
                        <Skeleton.Box key={index} width={width} height={15} borderRadius={6} />
                      )),
                    ),
                  )
                    .wrap()
                    .horizontalSpacing('lg')
                    .verticalSpacing('sm'),
                ),
              ),
            )
              .padding('horizontal', 'lg')
              .padding('bottom', 'lg'),
            HStack(
              Embed(
                CHANNEL_TAB_CHIP_WIDTHS.map((width, index) =>
                  toElement(
                    VStack(
                      Embed(<Skeleton.Box width={width} height={14} borderRadius={6} />),
                      index === 0
                        ? VStack()
                            .frame({ height: '2xs' })
                            .background('primary')
                            .corner('xs', 'top')
                            .position({ bottom: 'none', left: 'md', right: 'md' })
                        : null,
                    )
                      .padding('vertical', '10')
                      .padding('horizontal', 'md')
                      .frame({ minWidth: '5xl' })
                      .align('center'),
                    index,
                  ),
                ),
              ),
            ).border('border', 'thin', 'bottom'),
            LEmbed(<FeedSkeleton count={FEED_ROW_COUNT} />),
          ).padding('top', insets.top + CHANNEL_CONTENT_OFFSET),
        )}
      </Skeleton.Region>
    );
  }

  return (
    <Skeleton.Region style={FULL_WIDTH}>
      {/* Banner and profile info block — the loaded profile's `CoverHeader`,
          with ProfileContent's padding. The band is dampened (`blend`) so the
          avatar placeholder reads clearly over it. */}
      <CoverHeader
        coverHeight={PROFILE_BANNER_HEIGHT}
        overlap={PROFILE_AVATAR_OVERLAP}
        cover={<Skeleton.Box blend width="100%" height={PROFILE_BANNER_HEIGHT} borderRadius={0} />}
        style={{ backgroundColor: surfaceFill }}
        contentStyle={{
          paddingHorizontal: LAYOUT.DEFAULT_PADDING,
          paddingBottom: LAYOUT.DEFAULT_PADDING,
        }}
      >
        {/* Header row: avatar rising into the banner + action placeholders. */}
        {toElement(
          HStack(
            Embed(
              <Skeleton.Circle
                size={AVATAR_SIZE}
                style={{ borderWidth: PROFILE_AVATAR_RING, borderColor: surfaceFill }}
              />,
            ),
            HStack(
              Embed(<Skeleton.Box width={92} height={36} borderRadius={999} />),
              Embed(<Skeleton.Circle size={40} />),
            )
              .align('center')
              .spacing('md'),
          )
            .justify('between')
            .align('end')
            .margin('bottom', '10'),
        )}

        {/* Display name (fontSize 24) + handle (fontSize 15). */}
        {toElement(
          VStack(Embed(<Skeleton.Box width="55%" height={22} borderRadius={6} />))
            .margin('top', '10')
            .margin('bottom', 'xs'),
        )}
        {toElement(
          VStack(Embed(<Skeleton.Box width="32%" height={14} borderRadius={6} />)).margin(
            'bottom',
            'md',
          ),
        )}

        {/* Bio (two lines). */}
        {toElement(
          VStack(
            Embed(<Skeleton.Box width="92%" height={14} borderRadius={6} />),
            Embed(<Skeleton.Box width="78%" height={14} borderRadius={6} />),
          )
            .margin('bottom', 'md')
            .spacing('sm'),
        )}

        {/* Meta row (location · joined). */}
        {LtoElement(
          LHStack(
            LEmbed(<Skeleton.Box width={110} height={15} borderRadius={6} />),
            LEmbed(<Skeleton.Box width={150} height={15} borderRadius={6} />),
          )
            .wrap()
            .margin('bottom', 'md')
            .horizontalSpacing('lg')
            .verticalSpacing('xs'),
        )}

        {/* Stats row (following / followers / posts / boosts / replies). */}
        {LtoElement(
          LHStack(
            LEmbed(
              STAT_CHIP_WIDTHS.map((width, index) => (
                <Skeleton.Box key={index} width={width} height={15} borderRadius={6} />
              )),
            ),
          )
            .wrap()
            .horizontalSpacing('lg')
            .verticalSpacing('sm'),
        )}
      </CoverHeader>
      {/* Tab bar — matches the Bloom Tabs strip (bottom border, `py-2.5 px-3`
          min-60 cells) with an active-indicator hint under the first tab. */}
      {toElement(
        HStack(
          TAB_CHIP_WIDTHS.map((width, index) =>
            VStack(
              Embed(<Skeleton.Box width={width} height={14} borderRadius={6} />),
              index === 0
                ? VStack()
                    .frame({ height: '2xs' })
                    .background('primary')
                    .corner('xs', 'top')
                    .position({ bottom: 'none', left: 'md', right: 'md' })
                : null,
            )
              .padding('vertical', '10')
              .padding('horizontal', 'md')
              .frame({ minWidth: '5xl' })
              .align('center')
              .id(String(index)),
          ),
        )
          .background('surfaceFill')
          .border('border', 'thin', 'bottom'),
      )}
      {/* Placeholder feed rows below the tab bar. */}
      <FeedSkeleton count={FEED_ROW_COUNT} />
    </Skeleton.Region>
  );
});
