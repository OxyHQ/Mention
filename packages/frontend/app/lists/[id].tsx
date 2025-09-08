import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { useLocalSearchParams } from 'expo-router';
import { Header } from '@/components/Header';
import { colors } from '@/styles/colors';
import { listsService } from '@/services/listsService';
import Feed from '@/components/Feed/Feed';

export default function ListTimelineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [list, setList] = useState<any | null>(null);
  const [_loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    <ThemedView style={{ flex: 1 }}>
      <Header options={{ title: list?.title || 'List', showBackButton: true }} />
      {error ? (
        <View style={styles.center}><Text style={{ color: colors.busy }}>{error}</Text></View>
      ) : !list ? (
        <View style={styles.center}><Text>Loading…</Text></View>
      ) : (
        <Feed
          type={'mixed' as any}
          filters={{ authors: (list.memberOxyUserIds || []).join(',') }}
          recycleItems={true}
          maintainVisibleContentPosition={true}
          listHeaderComponent={(
            <View style={styles.headerBox}>
              {list.description ? <Text style={styles.desc}>{list.description}</Text> : null}
              <Text style={styles.meta}>{(list.memberOxyUserIds || []).length} members • {list.isPublic ? 'Public' : 'Private'}</Text>
            </View>
          )}
        />
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerBox: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, backgroundColor: colors.primaryLight },
  desc: { color: colors.COLOR_BLACK_LIGHT_3 },
  meta: { marginTop: 6, color: colors.COLOR_BLACK_LIGHT_5, fontSize: 12 },
});

