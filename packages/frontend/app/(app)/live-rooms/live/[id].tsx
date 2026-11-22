import { useEffect } from 'react';
import { useRouter, useLocalSearchParams } from '@/lib/navigation/router';
import { useLiveRoom } from '@/context/LiveRoomContext';

import { VStack, toElement } from '@oxy.so/bloom-language';

/**
 * Deep link redirect: when navigating to /live-rooms/live/[id],
 * open the live room bottom sheet and go back to the live-rooms list.
 */
export default function LiveRoomRedirect() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { joinLiveRoom } = useLiveRoom();

  useEffect(() => {
    if (id) {
      joinLiveRoom(id);
      router.replace('/live-rooms');
    }
  }, [id, joinLiveRoom]);

  return toElement(VStack());
}
