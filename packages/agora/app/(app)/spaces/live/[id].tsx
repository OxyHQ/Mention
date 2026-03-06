import { useEffect } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useLiveRoom } from '@mention/agora-shared';

export default function LiveRoomRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { joinLiveRoom } = useLiveRoom();

  useEffect(() => {
    if (id) {
      joinLiveRoom(id);
      router.replace('/(app)/(tabs)');
    }
  }, [id, joinLiveRoom]);

  return <View />;
}
