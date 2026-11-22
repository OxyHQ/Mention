import type React from 'react';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Embed, HStack, VStack, toElement } from '@oxy.so/bloom-language';

/**
 * Placeholder for the initial live-rooms load. The SDK `RoomCard` renders TWO
 * shapes depending on `room.status`, so the skeleton mirrors BOTH — otherwise the
 * real cards land somewhere other than where the placeholder painted:
 *
 *  - LIVE rooms -> a featured card (status pill + listener count, title, speaker
 *    avatars, host byline + Join CTA) inside a rounded surface.
 *  - everything else -> a compact full-width row (host avatar, title + date),
 *    flush with a hairline divider.
 *
 * Same treatment the feed and notifications use instead of a blank screen.
 */
const FEATURED_PLACEHOLDERS = 2;
const ROW_PLACEHOLDERS = 3;
const SPEAKER_PLACEHOLDERS = 3;

/** Mirrors the featured (live) card: rounded surface, chip, title, speakers, byline + CTA. */
const FeaturedRoomSkeleton: React.FC = () =>
  toElement(
    VStack(
      /* LIVE chip + "· N listening" */ Embed(
        <Skeleton.Row style={{ alignItems: 'center', gap: 6 }}>
          <Skeleton.Pill size={18} style={{ width: 48 }} />
          <Skeleton.Text style={{ fontSize: 13, lineHeight: 18, width: 96 }} />
        </Skeleton.Row>,
      ),
      /* Title (17px / 22px) */ Embed(
        <Skeleton.Text style={{ fontSize: 17, lineHeight: 22, width: '80%' }} />,
      ),
      /* Overlapping speaker avatars */ Embed(
        <Skeleton.Row style={{ alignItems: 'center' }}>
          {Array.from({ length: SPEAKER_PLACEHOLDERS }).map((_, index) =>
            toElement(
              VStack(Embed(<Skeleton.Circle size={36} />)).when(!(index === 0), (v) =>
                v.margin('left', '-md'),
              ),
              index,
            ),
          )}
        </Skeleton.Row>,
      ),
      /* Host byline + Join CTA */ Embed(
        <Skeleton.Row style={{ alignItems: 'center', gap: 8 }}>
          <Skeleton.Circle size={20} />
          <Skeleton.Text style={{ fontSize: 13, lineHeight: 18, width: 120 }} />
          {toElement(VStack().flex('1'))}
          <Skeleton.Pill size={28} style={{ width: 64 }} />
        </Skeleton.Row>,
      ),
    )
      .padding('all', 'md')
      .frame({ width: 'full' })
      .background('surface')
      .border('border', 'thin')
      .corner('lg')
      .margin('bottom', 'md')
      .spacing('10'),
  );

/** Mirrors the compact (scheduled/ended) row: host avatar + title/date, hairline divider. */
const RoomRowSkeleton: React.FC = () =>
  toElement(
    HStack(
      Embed(<Skeleton.Circle size={40} />),
      VStack(
        Embed(<Skeleton.Text style={{ fontSize: 15, lineHeight: 20, width: '65%' }} />),
        Embed(<Skeleton.Text style={{ fontSize: 13, lineHeight: 18, width: '40%' }} />),
      )
        .flex('1')
        .spacing('xs'),
    )
      .padding('horizontal', 'md')
      .padding('vertical', 'md')
      .frame({ width: 'full' })
      .border('border', 'thin', 'bottom')
      .align('center')
      .spacing('md'),
  );

export const RoomsListSkeleton: React.FC = () => (
  <Skeleton.Region className="w-full mt-4">
    {toElement(
      VStack(
        Embed(
          Array.from({ length: FEATURED_PLACEHOLDERS }).map((_, index) => (
            <FeaturedRoomSkeleton key={`featured-${index}`} />
          )),
        ),
      ).padding('horizontal', 'lg'),
    )}
    {Array.from({ length: ROW_PLACEHOLDERS }).map((_, index) => (
      <RoomRowSkeleton key={`row-${index}`} />
    ))}
  </Skeleton.Region>
);
