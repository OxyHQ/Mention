import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Header } from '@/components/Header';
import { ThemedView } from '@/components/ThemedView';
import { router } from 'expo-router';
import { getData, storeData } from '@/utils/storage';
import { customFeedsService } from '@/services/customFeedsService';
import { useTheme } from '@/hooks/useTheme';

const PINNED_KEY = 'mention.pinnedFeeds';

const MyFeedsRow = ({
  icon,
  label,
  onPress,
  chevron = false,
}: {
  icon: React.ReactNode;
  label: string;
  onPress?: () => void;
  chevron?: boolean;
}) => {
  const theme = useTheme();
  return (
    <TouchableOpacity style={[styles.myFeedRow, { borderBottomColor: theme.colors.border }]} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.myFeedIcon, { backgroundColor: theme.colors.backgroundSecondary }]}>{icon}</View>
      <Text style={[styles.myFeedLabel, { color: theme.colors.text }]}>{label}</Text>
      {chevron && (
        <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
      )}
    </TouchableOpacity>
  );
};

const PublicFeedCard = ({
  item,
  pinned,
  onTogglePin,
}: {
  item: any;
  pinned: boolean;
  onTogglePin: (id: string) => void;
}) => {
  const theme = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: theme.colors.card }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={[styles.cardEmojiBubble, { backgroundColor: theme.colors.backgroundSecondary }]}><Text style={{ fontSize: 18 }}>🧩</Text></View>
        <View style={{ marginLeft: 10, flex: 1 }}>
          <Text style={[styles.cardTitle, { color: theme.colors.text }]}>{item.title}</Text>
          <Text style={[styles.cardBy, { color: theme.colors.textSecondary }]}>{(item.memberOxyUserIds || []).length} members • Public</Text>
        </View>
        <TouchableOpacity onPress={() => onTogglePin(`custom:${item._id || item.id}`)} style={[styles.pinBtn, { backgroundColor: pinned ? theme.colors.primary : theme.colors.backgroundSecondary, borderColor: theme.colors.primary }]}>
          <Ionicons name={pinned ? 'pin' : 'pin-outline'} size={16} color={pinned ? theme.colors.card : theme.colors.primary} />
          <Text style={[styles.pinBtnText, { color: pinned ? theme.colors.card : theme.colors.primary }]}>{pinned ? 'Pinned' : 'Pin'}</Text>
        </TouchableOpacity>
      </View>
      {item.description ? <Text style={[styles.cardDesc, { color: theme.colors.textSecondary }]}>{item.description}</Text> : null}
      <TouchableOpacity onPress={() => router.push(`/feeds/${item._id || item.id}`)} style={{ marginTop: 8 }}>
        <Text style={{ color: theme.colors.primary, fontWeight: '600' }}>Open feed</Text>
      </TouchableOpacity>
    </View>
  );
};

const FeedsScreen: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const [pinned, setPinned] = useState<string[]>([]);
  const [myFeeds, setMyFeeds] = useState<any[]>([]);
  const [publicFeeds, setPublicFeeds] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const stored = (await getData<string[]>(PINNED_KEY)) || [];
      setPinned(stored);
    })();
  }, []);

  useEffect(() => {
    const loadFeeds = async () => {
      try {
        setLoading(true);
        const mine = await customFeedsService.list({ mine: true });
        setMyFeeds(mine.items || []);
        const pub = await customFeedsService.list({ publicOnly: true });
        // filter out ones already mine
        const mineIds = new Set((mine.items || []).map((f: any) => String(f._id || f.id)));
        setPublicFeeds((pub.items || []).filter((f: any) => !mineIds.has(String(f._id || f.id))));
      } catch (e) {
        console.warn('Failed loading feeds', e);
      } finally {
        setLoading(false);
      }
    };
    loadFeeds();
  }, []);

  const onTogglePin = useCallback(async (id: string) => {
    setPinned((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      // Persist async but do not block UI
      storeData(PINNED_KEY, next).catch(() => { });
      return next;
    });
  }, []);

  const pinnedObjects = useMemo(() => {
    const customPinned = myFeeds.filter((f: any) => pinned.includes(`custom:${f._id || f.id}`));
    return customPinned.map((f: any) => ({ id: `custom:${f._id || f.id}`, title: f.title, emoji: '🧩' }));
  }, [pinned, myFeeds]);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ThemedView style={styles.container}>
        <Header options={{
          title: t('Feeds'), rightComponents: [
            <TouchableOpacity key="search" onPress={() => router.push('/search')} style={{ padding: 8 }}>
              <Ionicons name="search-outline" size={22} color={theme.colors.textSecondary} />
            </TouchableOpacity>,
            <TouchableOpacity key="create" onPress={() => router.push('/feeds/create')} style={{ padding: 8 }}>
              <Ionicons name="add-circle-outline" size={22} color={theme.colors.primary} />
            </TouchableOpacity>
          ]
        }} />

        <ScrollView showsVerticalScrollIndicator={false}>
          {/* My Feeds */}
          <View style={styles.sectionHeaderRow}>
            <View style={[styles.sectionHeaderIcon, { backgroundColor: theme.colors.primary }]}>
              <Ionicons name="filter" size={18} color={theme.colors.card} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>My Feeds</Text>
              <Text style={[styles.sectionSub, { color: theme.colors.textSecondary }]}>All the feeds you've saved, right in one place.</Text>
            </View>
          </View>

          <View style={[styles.myFeedsBox, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
            <MyFeedsRow
              icon={<Ionicons name="people-outline" size={18} color={theme.colors.primary} />}
              label="Following"
              onPress={() => router.push('/')}
            />
            <MyFeedsRow
              icon={<Ionicons name="sparkles-outline" size={18} color={theme.colors.primary} />}
              label="For You"
              onPress={() => router.push('/')}
            />
            {pinnedObjects.map((f) => (
              <MyFeedsRow
                key={f.id}
                icon={<Text style={{ fontSize: 14 }}>{(f as any).emoji || '🧩'}</Text>}
                label={(f as any).title}
                onPress={() => {
                  const id = String(f.id).startsWith('custom:') ? String(f.id).split(':')[1] : undefined;
                  if (id) router.push(`/feeds/${id}`);
                }}
                chevron
              />
            ))}
          </View>

          {/* Discover New Feeds (public) */}
          <View style={[styles.sectionHeaderRow, { marginTop: 16 }]}>
            <View style={[styles.sectionHeaderIcon, { backgroundColor: theme.colors.primary }]}>
              <Ionicons name="options" size={18} color={theme.colors.card} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Discover New Feeds</Text>
              <Text style={[styles.sectionSub, { color: theme.colors.textSecondary }]}>
                Choose your own timeline! Feeds built by the community help you find
                content you love.
              </Text>
            </View>
          </View>

          {publicFeeds.map((item: any) => (
            <PublicFeedCard
              key={String(item._id || item.id)}
              item={item}
              pinned={pinned.includes(`custom:${item._id || item.id}`)}
              onTogglePin={onTogglePin}
            />
          ))}

          {/* Your Feeds */}
          {myFeeds.length > 0 && (
            <>
              <View style={[styles.sectionHeaderRow, { marginTop: 16 }]}>
                <View style={[styles.sectionHeaderIcon, { backgroundColor: theme.colors.primary }]}>
                  <Ionicons name="person-circle" size={18} color={theme.colors.card} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Your Feeds</Text>
                  <Text style={[styles.sectionSub, { color: theme.colors.textSecondary }]}>Custom timelines you created.</Text>
                </View>
              </View>
              {myFeeds.map((f: any) => (
                <View key={String(f._id || f.id)} style={[styles.card, { backgroundColor: theme.colors.card }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={[styles.cardEmojiBubble, { backgroundColor: theme.colors.backgroundSecondary }]}><Text style={{ fontSize: 18 }}>🧩</Text></View>
                    <View style={{ marginLeft: 10, flex: 1 }}>
                      <Text style={[styles.cardTitle, { color: theme.colors.text }]}>{f.title}</Text>
                      <Text style={[styles.cardBy, { color: theme.colors.textSecondary }]}>{(f.memberOxyUserIds || []).length} members • {f.isPublic ? 'Public' : 'Private'}</Text>
                    </View>
                    <TouchableOpacity onPress={() => onTogglePin(`custom:${f._id || f.id}`)} style={[styles.pinBtn, { backgroundColor: pinned.includes(`custom:${f._id || f.id}`) ? theme.colors.primary : theme.colors.backgroundSecondary, borderColor: theme.colors.primary }]}>
                      <Ionicons name={pinned.includes(`custom:${f._id || f.id}`) ? 'pin' : 'pin-outline'} size={16} color={pinned.includes(`custom:${f._id || f.id}`) ? theme.colors.card : theme.colors.primary} />
                      <Text style={[styles.pinBtnText, { color: pinned.includes(`custom:${f._id || f.id}`) ? theme.colors.card : theme.colors.primary }]}>{pinned.includes(`custom:${f._id || f.id}`) ? 'Pinned' : 'Pin'}</Text>
                    </TouchableOpacity>
                  </View>
                  {f.description ? <Text style={[styles.cardDesc, { color: theme.colors.textSecondary }]}>{f.description}</Text> : null}
                  <TouchableOpacity onPress={() => router.push(`/feeds/${f._id || f.id}`)} style={{ marginTop: 8 }}>
                    <Text style={{ color: theme.colors.primary, fontWeight: '600' }}>Open feed</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </>
          )}

          <View style={{ height: 20 }} />
        </ScrollView>
      </ThemedView>
    </SafeAreaView>
  );
};

export default FeedsScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  sectionHeaderIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '800',
  },
  sectionSub: {
    fontSize: 13,
    marginTop: 3,
  },
  myFeedsBox: {
    marginTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  myFeedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  myFeedIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  myFeedLabel: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  card: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 1,
  },
  cardEmojiBubble: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  cardBy: {
    marginTop: 2,
    fontSize: 12,
  },
  cardDesc: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 18,
  },
  cardLikes: {
    marginTop: 8,
    fontSize: 12,
  },
  pinBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  pinBtnActive: {
    // Active state handled inline with theme
  },
  pinBtnText: {
    marginLeft: 6,
    fontSize: 12,
    fontWeight: '700',
  },
  separator: {
    height: 1,
  },
});

export default FeedsScreen;
});
