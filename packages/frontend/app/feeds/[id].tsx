import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { useLocalSearchParams } from 'expo-router';
import { Header } from '@/components/Header';
import { useTheme } from '@/hooks/useTheme';
import { customFeedsService } from '@/services/customFeedsService';
import { listsService } from '@/services/listsService';
import Feed from '@/components/Feed/Feed';

export default function CustomFeedTimelineScreen() {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [feed, setFeed] = useState<any | null>(null);
  const [_loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authorsCsv, setAuthorsCsv] = useState<string>('');

  useEffect(() => {
    (async () => {
      try {
        const f = await customFeedsService.get(String(id));
        setFeed(f);
        // Only include explicitly added members, NOT the owner unless they're in the list
        let authors = new Set<string>(f.memberOxyUserIds || []);
        if (f.sourceListIds && f.sourceListIds.length) {
          for (const lid of f.sourceListIds) {
            try {
              const l = await listsService.get(String(lid));
              (l.memberOxyUserIds || []).forEach((uid: string) => authors.add(uid));
            } catch { }
          }
        }
        // Explicitly remove owner if they're not in the member list
        // This ensures owner's posts are only shown if they explicitly added themselves
        const ownerId = f.ownerOxyUserId;
        if (ownerId && !f.memberOxyUserIds?.includes(ownerId)) {
          authors.delete(ownerId);
        }
        setAuthorsCsv(Array.from(authors).join(','));
      } catch {
        setError('Failed to load feed');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  return (
    <ThemedView style={{ flex: 1 }}>
      <Header options={{ title: feed?.title || 'Feed', showBackButton: true }} />
      {error ? (
        <View style={styles.center}>
          <Text style={{ color: theme.colors.error || theme.colors.textSecondary }}>{error}</Text>
        </View>
      ) : !feed ? (
        <View style={styles.center}>
          <Text style={{ color: theme.colors.text }}>Loading…</Text>
        </View>
      ) : (
        <Feed
          type="mixed"
          filters={{
            authors: authorsCsv,
            keywords: (feed.keywords || []).join(','),
            includeReplies: feed.includeReplies,
            includeReposts: feed.includeReposts,
            includeMedia: feed.includeMedia,
            language: feed.language,
            excludeOwner: true // Exclude feed owner unless they're explicitly in members list
          }}
          recycleItems={true}
          maintainVisibleContentPosition={true}
          listHeaderComponent={(
            <View style={[styles.headerBox, { backgroundColor: theme.colors.backgroundSecondary }]}>
              {feed.description ? (
                <Text style={[styles.desc, { color: theme.colors.text }]}>
                  {feed.description}
                </Text>
              ) : null}
              <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
                {(feed.memberOxyUserIds || []).length} members • {feed.isPublic ? 'Public' : 'Private'}
              </Text>
            </View>
          )}
        />
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  headerBox: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8
  },
  desc: {
    fontSize: 14,
    lineHeight: 20,
  },
  meta: {
    marginTop: 6,
    fontSize: 12
  },
});
