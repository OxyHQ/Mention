import React from 'react';
import { View } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';

/**
 * Placeholder for the initial live-rooms load. Mirrors the anatomy of the SDK
 * `RoomCard` (status pill, title, host/listener meta line, speaker avatar row)
 * so the list paints instantly and the real cards land in the same place —
 * same treatment the feed and notifications use instead of a blank screen.
 */
const PLACEHOLDER_CARDS = 3;
const SPEAKER_PLACEHOLDERS = 3;

const RoomCardSkeleton: React.FC = () => (
  <View className="mb-3 gap-3 rounded-xl border border-border bg-card p-4">
    <Skeleton.Pill size={18} style={{ width: 64 }} />
    <Skeleton.Text style={{ fontSize: 16, lineHeight: 22, width: '70%' }} />
    <Skeleton.Row style={{ alignItems: 'center', gap: 8 }}>
      <Skeleton.Circle size={14} />
      <Skeleton.Text style={{ fontSize: 12, lineHeight: 16, width: 140 }} />
    </Skeleton.Row>
    <Skeleton.Row style={{ gap: 6 }}>
      {Array.from({ length: SPEAKER_PLACEHOLDERS }).map((_, index) => (
        <Skeleton.Circle key={index} size={28} />
      ))}
    </Skeleton.Row>
  </View>
);

export const RoomsListSkeleton: React.FC = () => (
  <View className="mt-4 px-4" accessibilityRole="progressbar">
    {Array.from({ length: PLACEHOLDER_CARDS }).map((_, index) => (
      <RoomCardSkeleton key={index} />
    ))}
  </View>
);

export default RoomsListSkeleton;
