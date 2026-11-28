import { View } from 'react-native';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { ResponsiveGrid } from '@oxy.so/bloom/grid';
import { POST_ITEM_SPACING } from '@/styles/shared';

/** Mention content anatomy; Bloom owns animation, accessibility and responsive layout. */
export function FeedSkeleton({ count = 5 }: { count?: number }) {
  return (
    <Skeleton.Region testID="feed-skeleton" style={{ width: '100%' }}>
      {Array.from({ length: count }, (_, index) => (
        <View key={index} className="w-full border-b border-border px-3 py-3 flex-row gap-3">
          <Skeleton.Circle size={POST_ITEM_SPACING.AVATAR_SIZE} />
          <View className="flex-1 gap-2">
            <Skeleton.Box width="48%" height={14} borderRadius={6} />
            <Skeleton.Box width="94%" height={14} borderRadius={6} />
            <Skeleton.Box width={index % 2 ? '68%' : '82%'} height={14} borderRadius={6} />
            <View className="flex-row justify-between pt-3">
              {[0, 1, 2, 3].map((key) => (
                <Skeleton.Circle key={key} size={18} />
              ))}
            </View>
          </View>
        </View>
      ))}
    </Skeleton.Region>
  );
}

export function ListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <Skeleton.Region testID="list-skeleton" style={{ width: '100%' }}>
      {Array.from({ length: count }, (_, index) => (
        <View key={index} className="px-4 py-4 border-b border-border flex-row items-center gap-3">
          <Skeleton.Circle size={40} />
          <View className="flex-1 gap-2">
            <Skeleton.Box width="55%" height={16} borderRadius={6} />
            <Skeleton.Box width="80%" height={12} borderRadius={6} />
          </View>
        </View>
      ))}
    </Skeleton.Region>
  );
}

export function FormSkeleton({ count = 4 }: { count?: number }) {
  return (
    <Skeleton.Region testID="form-skeleton" style={{ width: '100%', padding: 16, gap: 20 }}>
      {Array.from({ length: count }, (_, index) => (
        <View key={index} className="gap-2">
          <Skeleton.Box width="34%" height={14} borderRadius={6} />
          <Skeleton.Box width="100%" height={index === 1 ? 96 : 44} borderRadius={12} />
        </View>
      ))}
    </Skeleton.Region>
  );
}

export function SettingsSkeleton({ count = 5 }: { count?: number }) {
  return (
    <Skeleton.Region testID="settings-skeleton" style={{ width: '100%', gap: 12 }}>
      {Array.from({ length: count }, (_, index) => (
        <View
          key={index}
          className="flex-row items-center gap-4 p-4 rounded-2xl border border-border"
        >
          <View className="flex-1 gap-2">
            <Skeleton.Box width="55%" height={15} borderRadius={6} />
            <Skeleton.Box width="85%" height={12} borderRadius={6} />
          </View>
          <Skeleton.Box width={40} height={24} borderRadius={12} />
        </View>
      ))}
    </Skeleton.Region>
  );
}

export function PollSkeleton() {
  return (
    <Skeleton.Region testID="poll-skeleton" style={{ width: '100%', gap: 12 }}>
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
    <Skeleton.Region testID="detail-skeleton" style={{ width: '100%', padding: 16, gap: 20 }}>
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
    <Skeleton.Region
      testID="media-grid-skeleton"
      style={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap' }}
    >
      {Array.from({ length: count }, (_, index) => (
        <View key={index} className="w-1/3 p-0.5">
          <Skeleton.Box width="100%" style={{ aspectRatio: 1 }} borderRadius={0} />
        </View>
      ))}
    </Skeleton.Region>
  );
}

export function InsightsSkeleton() {
  return (
    <Skeleton.Region testID="insights-skeleton" style={{ width: '100%', padding: 16, gap: 16 }}>
      <Skeleton.Box width={220} height={36} borderRadius={18} />
      <ResponsiveGrid stretchItems>
        {[0, 1, 2, 3].map((index) => (
          <View key={index} className="w-full gap-4 p-5 rounded-3xl border border-border">
            <Skeleton.Box width="45%" height={16} borderRadius={6} />
            <Skeleton.Box width="35%" height={36} borderRadius={8} />
            <Skeleton.Box width="100%" height={160} borderRadius={12} />
            <View className="flex-row gap-4">
              <Skeleton.Box width="40%" height={28} borderRadius={8} />
              <Skeleton.Box width="40%" height={28} borderRadius={8} />
            </View>
          </View>
        ))}
      </ResponsiveGrid>
    </Skeleton.Region>
  );
}

export function VideoSkeleton() {
  return (
    // The wrapper holds the per-platform minimum height; the region fills it.
    <View className="w-full flex-1 native:min-h-96 web:min-h-[var(--bloom-screen-viewport-height)]">
      <Skeleton.Region
        testID="video-skeleton"
        style={{ flexGrow: 1, justifyContent: 'flex-end', gap: 16, padding: 24 }}
      >
        <View className="flex-1" />
        <View className="flex-row items-center gap-3">
          <Skeleton.Circle size={40} />
          <Skeleton.Box width="40%" height={16} borderRadius={6} />
        </View>
        <Skeleton.Box width="85%" height={14} borderRadius={6} />
        <Skeleton.Box width="65%" height={14} borderRadius={6} />
      </Skeleton.Region>
    </View>
  );
}

export function WatchVideoSkeleton({ showDetails }: { showDetails: boolean }) {
  return (
    <Skeleton.Region
      testID="watch-video-skeleton"
      style={{ width: '100%', gap: 16, paddingHorizontal: 12, paddingBottom: 32, paddingTop: 8 }}
    >
      <Skeleton.Box width="100%" style={{ aspectRatio: 16 / 9 }} borderRadius={16} />
      {showDetails && (
        <View className="gap-2">
          <Skeleton.Box width="76%" height={22} borderRadius={6} />
          <Skeleton.Box width="40%" height={13} borderRadius={5} />
          <Skeleton.Box width="88%" height={13} borderRadius={5} />
        </View>
      )}
    </Skeleton.Region>
  );
}
