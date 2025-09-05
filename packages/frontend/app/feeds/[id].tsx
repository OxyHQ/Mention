import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Header } from '@/components/Header';
import { colors } from '@/styles/colors';
import { customFeedsService } from '@/services/customFeedsService';
import Feed from '@/components/Feed/Feed';

export default function CustomFeedTimelineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [feed, setFeed] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const f = await customFeedsService.get(String(id));
        setFeed(f);
      } catch (e) {
        setError('Failed to load feed');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.primaryLight }}>
      <Header options={{ title: feed?.title || 'Feed', showBackButton: true }} />
      {error ? (
        <View style={styles.center}><Text style={{ color: colors.busy }}>{error}</Text></View>
      ) : !feed ? (
        <View style={styles.center}><Text>Loading…</Text></View>
      ) : (
        <Feed
          type="mixed" as any
          filters={{ authors: (feed.memberOxyUserIds || []).join(',') }}
          listHeaderComponent={(
            <View style={styles.headerBox}>
              {feed.description ? <Text style={styles.desc}>{feed.description}</Text> : null}
              <Text style={styles.meta}>{(feed.memberOxyUserIds || []).length} members • {feed.isPublic ? 'Public' : 'Private'}</Text>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerBox: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, backgroundColor: colors.primaryLight },
  desc: { color: colors.COLOR_BLACK_LIGHT_3 },
  meta: { marginTop: 6, color: colors.COLOR_BLACK_LIGHT_5, fontSize: 12 },
});

