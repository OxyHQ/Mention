import { useEffect } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { useLiveSpace } from '@/context/LiveSpaceContext';

/**
 * Deep link redirect: when navigating to /spaces/live/[id],
 * open the live space bottom sheet and go back to the spaces list.
 */
export default function LiveSpaceRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { joinLiveSpace } = useLiveSpace();

  useEffect(() => {
    if (id) {
      joinLiveSpace(id);
      router.replace('/spaces');
    }
  }, [id, joinLiveSpace]);

  return <View />;
}
