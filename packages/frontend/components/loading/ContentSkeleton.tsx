import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Platform, StyleSheet, type ViewStyle } from 'react-native';
import { POST_ITEM_SPACING } from '@/styles/shared';

import { Embed, Grid, HStack, SkeletonGroup, VStack, toElement } from '@oxy.so/bloom-language';

/** Mention content anatomy; Bloom owns animation, accessibility and responsive layout. */
export function FeedSkeleton({ count = 5 }: { count?: number }) {
  return toElement(
    SkeletonGroup(
      Array.from({ length: count }, (_, index) =>
        HStack(
          Embed(<Skeleton.Circle size={POST_ITEM_SPACING.AVATAR_SIZE} />),
          VStack(
            Embed(<Skeleton.Box width="48%" height={14} borderRadius={6} />),
            Embed(<Skeleton.Box width="94%" height={14} borderRadius={6} />),
            Embed(<Skeleton.Box width={index % 2 ? '68%' : '82%'} height={14} borderRadius={6} />),
            HStack(Embed([0, 1, 2, 3].map((key) => <Skeleton.Circle key={key} size={18} />)))
              .padding('top', 'md')
              .justify('between'),
          )
            .flex('1')
            .spacing('sm'),
        )
          .padding('horizontal', 'md')
          .padding('vertical', 'md')
          .frame({ width: 'full' })
          .border('border', 'thin', 'bottom')
          .spacing('md')
          .id(index),
      ),
    )
      .frame({ width: 'full' })
      .testID('feed-skeleton'),
  );
}

export function ListSkeleton({ count = 5 }: { count?: number }) {
  return toElement(
    SkeletonGroup(
      Array.from({ length: count }, (_, index) =>
        HStack(
          Embed(<Skeleton.Circle size={40} />),
          VStack(
            Embed(<Skeleton.Box width="55%" height={16} borderRadius={6} />),
            Embed(<Skeleton.Box width="80%" height={12} borderRadius={6} />),
          )
            .flex('1')
            .spacing('sm'),
        )
          .padding('horizontal', 'lg')
          .padding('vertical', 'lg')
          .border('border', 'thin', 'bottom')
          .align('center')
          .spacing('md')
          .id(index),
      ),
    )
      .frame({ width: 'full' })
      .testID('list-skeleton'),
  );
}

export function FormSkeleton({ count = 4 }: { count?: number }) {
  return (
    <Skeleton.Region testID="form-skeleton" style={styles.form}>
      {Array.from({ length: count }, (_, index) =>
        toElement(
          VStack(
            Embed(<Skeleton.Box width="34%" height={14} borderRadius={6} />),
            Embed(<Skeleton.Box width="100%" height={index === 1 ? 96 : 44} borderRadius={12} />),
          ).spacing('sm'),
          index,
        ),
      )}
    </Skeleton.Region>
  );
}

export function SettingsSkeleton({ count = 5 }: { count?: number }) {
  return (
    <Skeleton.Region testID="settings-skeleton" style={styles.settings}>
      {Array.from({ length: count }, (_, index) =>
        toElement(
          HStack(
            VStack(
              Embed(<Skeleton.Box width="55%" height={15} borderRadius={6} />),
              Embed(<Skeleton.Box width="85%" height={12} borderRadius={6} />),
            )
              .flex('1')
              .spacing('sm'),
            Embed(<Skeleton.Box width={40} height={24} borderRadius={12} />),
          )
            .padding('all', 'lg')
            .border('border', 'thin')
            .corner('lg')
            .align('center')
            .spacing('lg'),
          index,
        ),
      )}
    </Skeleton.Region>
  );
}

export function PollSkeleton() {
  return (
    <Skeleton.Region testID="poll-skeleton" style={styles.poll}>
      <Skeleton.Box width="80%" height={18} borderRadius={6} />
      {[0, 1, 2].map((index) => (
        <Skeleton.Box key={index} width="100%" height={40} borderRadius={12} />
      ))}
      <Skeleton.Box width="35%" height={12} borderRadius={6} />
    </Skeleton.Region>
  );
}

export function DetailSkeleton() {
  return (
    <Skeleton.Region testID="detail-skeleton" style={styles.detail}>
      <Skeleton.Box width="75%" height={28} borderRadius={8} />
      <Skeleton.Box width="45%" height={14} borderRadius={6} />
      <Skeleton.Box width="100%" height={180} borderRadius={16} />
      {[0, 1, 2, 3, 4].map((index) => (
        <Skeleton.Box
          key={index}
          width={index === 4 ? '65%' : '100%'}
          height={14}
          borderRadius={6}
        />
      ))}
    </Skeleton.Region>
  );
}

export function MediaGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <Skeleton.Region testID="media-grid-skeleton" style={styles.mediaGrid}>
      {Array.from({ length: count }, (_, index) =>
        toElement(
          VStack(Embed(<Skeleton.Box width="100%" style={{ aspectRatio: 1 }} borderRadius={0} />))
            .padding('all', '2xs')
            .frame({ width: '1/3' }),
          index,
        ),
      )}
    </Skeleton.Region>
  );
}

export function InsightsSkeleton() {
  return (
    <Skeleton.Region testID="insights-skeleton" style={styles.insights}>
      <Skeleton.Box width={220} height={36} borderRadius={18} />
      {toElement(
        Grid(
          Embed(
            [0, 1, 2, 3].map((index) =>
              toElement(
                VStack(
                  Embed(<Skeleton.Box width="45%" height={16} borderRadius={6} />),
                  Embed(<Skeleton.Box width="35%" height={36} borderRadius={8} />),
                  Embed(<Skeleton.Box width="100%" height={160} borderRadius={12} />),
                  HStack(
                    Embed(<Skeleton.Box width="40%" height={28} borderRadius={8} />),
                    Embed(<Skeleton.Box width="40%" height={28} borderRadius={8} />),
                  ).spacing('lg'),
                )
                  .padding('all', 'xl')
                  .frame({ width: 'full' })
                  .border('border', 'thin')
                  .corner('2xl')
                  .spacing('lg'),
                index,
              ),
            ),
          ),
        ).stretchItems(),
      )}
    </Skeleton.Region>
  );
}

/**
 * The reel's placeholder fills the screen: at least 384pt on native, the
 * screen viewport's height on the web (`--bloom-screen-viewport-height`, a CSS
 * length the language's frame has no token for), so the region keeps a style.
 */
export function VideoSkeleton() {
  return (
    <Skeleton.Region testID="video-skeleton" style={styles.video}>
      {toElement(VStack().flex('1'))}
      {toElement(
        HStack(
          Embed(<Skeleton.Circle size={40} />),
          Embed(<Skeleton.Box width="40%" height={16} borderRadius={6} />),
        )
          .align('center')
          .spacing('md'),
      )}
      <Skeleton.Box width="85%" height={14} borderRadius={6} />
      <Skeleton.Box width="65%" height={14} borderRadius={6} />
    </Skeleton.Region>
  );
}

// A region lays its rows out itself (a gap, a wrapping row): the language's
// SkeletonGroup draws Bloom's region with box modifiers only, no stack layout.
const styles = StyleSheet.create({
  form: { width: '100%', padding: 16, gap: 20 },
  settings: { width: '100%', gap: 12 },
  poll: { width: '100%', gap: 12 },
  detail: { width: '100%', padding: 16, gap: 20 },
  mediaGrid: { width: '100%', flexDirection: 'row', flexWrap: 'wrap' },
  insights: { width: '100%', padding: 16, gap: 16 },
  // Tailwind's `w-full flex-1 justify-end gap-4 p-6` (flex-1 is grow 1, shrink 1, basis 0%).
  video: {
    width: '100%',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    justifyContent: 'flex-end',
    gap: 16,
    padding: 24,
    // React Native types a length as a number or a percentage; react-native-web
    // passes any CSS length through (as Bloom's own WEB_VIEWPORT_HEIGHT does).
    minHeight:
      Platform.OS === 'web'
        ? ('var(--bloom-screen-viewport-height)' as ViewStyle['minHeight'])
        : 384,
  },
});
