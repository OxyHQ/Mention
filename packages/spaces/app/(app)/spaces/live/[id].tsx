import { useEffect } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useLiveSpace } from '@mention/spaces-shared';

export default function LiveSpaceRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { joinLiveSpace } = useLiveSpace();

  useEffect(() => {
    if (id) {
      joinLiveSpace(id);
      router.replace('/(app)/(tabs)');
    }
  }, [id, joinLiveSpace]);

  return <View />;
}
