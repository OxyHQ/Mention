import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import ProfileScreen from '@/components/ProfileScreen';

/**
 * One lane's tab on a profile: `/@user/lane/<laneId>`.
 *
 * A subfolder rather than a `[laneId].tsx` beside `replies.tsx` and `media.tsx`,
 * because those static tab files and a dynamic id share one segment and the id
 * would swallow them all.
 *
 * It renders the whole profile — a lane tab IS a profile tab — and the lane id
 * only selects which one. `ProfileScreen` resolves it against the publisher's
 * live lane list, so an id that is gone, renamed away from a tab, or never
 * existed simply lands on `posts` instead of on a blank screen.
 */
export default function ProfileLaneRoute() {
    const { laneId } = useLocalSearchParams<{ laneId: string }>();
    return <ProfileScreen tab="posts" laneId={typeof laneId === 'string' ? laneId : undefined} />;
}
