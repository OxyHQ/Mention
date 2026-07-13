import React from 'react';
import { View } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';

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
const FeaturedRoomSkeleton: React.FC = () => (
  <View className="mb-3 w-full gap-2.5 rounded-2xl border border-border bg-surface p-3">
    {/* LIVE chip + "· N listening" */}
    <Skeleton.Row style={{ alignItems: 'center', gap: 6 }}>
      <Skeleton.Pill size={18} style={{ width: 48 }} />
      <Skeleton.Text style={{ fontSize: 13, lineHeight: 18, width: 96 }} />
    </Skeleton.Row>

    {/* Title (17px / 22px) */}
    <Skeleton.Text style={{ fontSize: 17, lineHeight: 22, width: '80%' }} />

    {/* Overlapping speaker avatars */}
    <Skeleton.Row style={{ alignItems: 'center' }}>
      {Array.from({ length: SPEAKER_PLACEHOLDERS }).map((_, index) => (
        <View key={index} className={index === 0 ? '' : '-ml-3'}>
          <Skeleton.Circle size={36} />
        </View>
      ))}
    </Skeleton.Row>

    {/* Host byline + Join CTA */}
    <Skeleton.Row style={{ alignItems: 'center', gap: 8 }}>
      <Skeleton.Circle size={20} />
      <Skeleton.Text style={{ fontSize: 13, lineHeight: 18, width: 120 }} />
      <View className="flex-1" />
      <Skeleton.Pill size={28} style={{ width: 64 }} />
    </Skeleton.Row>
  </View>
);

/** Mirrors the compact (scheduled/ended) row: host avatar + title/date, hairline divider. */
const RoomRowSkeleton: React.FC = () => (
  <View className="w-full flex-row items-center gap-3 border-b border-border px-3 py-3">
    <Skeleton.Circle size={40} />
    <View className="flex-1 gap-1">
      <Skeleton.Text style={{ fontSize: 15, lineHeight: 20, width: '65%' }} />
      <Skeleton.Text style={{ fontSize: 13, lineHeight: 18, width: '40%' }} />
    </View>
  </View>
);

export const RoomsListSkeleton: React.FC = () => (
  <View className="mt-4" accessibilityRole="progressbar">
    <View className="px-4">
      {Array.from({ length: FEATURED_PLACEHOLDERS }).map((_, index) => (
        <FeaturedRoomSkeleton key={`featured-${index}`} />
      ))}
    </View>
    {Array.from({ length: ROW_PLACEHOLDERS }).map((_, index) => (
      <RoomRowSkeleton key={`row-${index}`} />
    ))}
  </View>
);

export default RoomsListSkeleton;
