import { useEffect } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { useLiveRoom } from '@/context/LiveRoomContext';

/**
 * Deep link redirect: when navigating to /live-rooms/live/[id],
 * open the live room bottom sheet and go back to the live-rooms list.
 */
export default function LiveRoomRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { joinLiveRoom } = useLiveRoom();

  useEffect(() => {
    if (id) {
      joinLiveRoom(id);
      router.replace('/live-rooms');
    }
  }, [id, joinLiveRoom]);

  return <View />;
}
