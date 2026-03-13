import React, { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { useLocalSearchParams, router } from 'expo-router';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { listsService } from '@/services/listsService';
import Feed from '@/components/Feed/Feed';
import { useTheme } from '@/hooks/useTheme';

export default function ListTimelineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [list, setList] = useState<any | null>(null);
  const [_loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();

  useEffect(() => {
    (async () => {
      try {
        const l = await listsService.get(String(id));
        setList(l);
      } catch {
        setError('Failed to load list');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: list?.title || 'List',
          leftComponents: [
            <IconButton variant="icon"
              key="back"
              onPress={() => router.back()}
            >
              <BackArrowIcon size={20} color={theme.colors.text} />
            </IconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />
      {error ? (
        <View className="flex-1 items-center justify-center"><Text className="text-destructive">{error}</Text></View>
      ) : !list ? (
        <View className="flex-1 items-center justify-center"><Text>Loading…</Text></View>
      ) : (
        <Feed
          type={'mixed' as any}
          filters={{ authors: (list.memberOxyUserIds || []).join(',') }}
          recycleItems={true}
          maintainVisibleContentPosition={true}
          listHeaderComponent={(
            <View className="px-4 pt-3 pb-2 bg-background">
              {list.description ? <Text className="text-muted-foreground font-primary">{list.description}</Text> : null}
              <Text className="mt-1.5 text-muted-foreground text-xs font-primary">{(list.memberOxyUserIds || []).length} members • {list.isPublic ? 'Public' : 'Private'}</Text>
            </View>
          )}
        />
      )}
    </ThemedView>
  );
}
