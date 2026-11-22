import * as Skeleton from '@oxy.so/bloom/skeleton';
import { POST_ITEM_SPACING } from '@/styles/shared';

import { Embed, Grid, HStack, VStack, toElement } from '@oxy.so/bloom-language';

/** Mention content anatomy; Bloom owns animation, accessibility and responsive layout. */
export function FeedSkeleton({ count = 5 }: { count?: number }) {
  return (
    <Skeleton.Region testID="feed-skeleton" className="w-full">
      {Array.from({ length: count }, (_, index) =>
        toElement(
          HStack(
            Embed(<Skeleton.Circle size={POST_ITEM_SPACING.AVATAR_SIZE} />),
            VStack(
              Embed(<Skeleton.Box width="48%" height={14} borderRadius={6} />),
              Embed(<Skeleton.Box width="94%" height={14} borderRadius={6} />),
              Embed(
                <Skeleton.Box width={index % 2 ? '68%' : '82%'} height={14} borderRadius={6} />,
              ),
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
            .spacing('md'),
          index,
        ),
      )}
    </Skeleton.Region>
  );
}

export function ListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <Skeleton.Region testID="list-skeleton" className="w-full">
      {Array.from({ length: count }, (_, index) =>
        toElement(
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
            .spacing('md'),
          index,
        ),
      )}
    </Skeleton.Region>
  );
}

export function FormSkeleton({ count = 4 }: { count?: number }) {
  return (
    <Skeleton.Region testID="form-skeleton" className="w-full p-4 gap-5">
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
    <Skeleton.Region testID="settings-skeleton" className="w-full gap-3">
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
    <Skeleton.Region testID="poll-skeleton" className="w-full gap-3">
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
    <Skeleton.Region testID="detail-skeleton" className="w-full p-4 gap-5">
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
    <Skeleton.Region testID="media-grid-skeleton" className="w-full flex-row flex-wrap">
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
    <Skeleton.Region testID="insights-skeleton" className="w-full p-4 gap-4">
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

export function VideoSkeleton() {
  return (
    <Skeleton.Region
      testID="video-skeleton"
      className="w-full flex-1 justify-end gap-4 p-6 native:min-h-96 web:min-h-[var(--bloom-screen-viewport-height)]"
    >
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
