import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  StyleSheet,
  TextInput,
  // FlatList replaced with LegendList for performance
  TouchableOpacity,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Header } from '@/components/Header';
import { ThemedView } from '@/components/ThemedView';
import { colors } from '@/styles/colors';
import { router } from 'expo-router';
import { getData, storeData } from '@/utils/storage';
import LegendList from '@/components/LegendList';
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
}) => (
  <TouchableOpacity style={styles.myFeedRow} onPress={onPress} activeOpacity={0.7}>
    <View style={styles.myFeedIcon}>{icon}</View>
    <Text style={styles.myFeedLabel}>{label}</Text>
    {chevron && (
      <Ionicons name="chevron-forward" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
    )}
  </TouchableOpacity>
);

const PublicFeedCard = ({
  item,
  pinned,
  onTogglePin,
}: {
  item: any;
  pinned: boolean;
  onTogglePin: (id: string) => void;
}) => (
  <View style={styles.card}>
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <View style={styles.cardEmojiBubble}><Text style={{ fontSize: 18 }}>🧩</Text></View>
      <View style={{ marginLeft: 10, flex: 1 }}>
        <Text style={styles.cardTitle}>{item.title}</Text>
        <Text style={styles.cardBy}>{(item.memberOxyUserIds || []).length} members • Public</Text>
      </View>
      <TouchableOpacity onPress={() => onTogglePin(`custom:${item._id || item.id}`)} style={[styles.pinBtn, pinned ? styles.pinBtnActive : undefined]}>
        <Ionicons name={pinned ? 'pin' : 'pin-outline'} size={16} color={pinned ? colors.primaryLight : colors.primaryColor} />
        <Text style={[styles.pinBtnText, pinned ? { color: colors.primaryLight } : undefined]}>{pinned ? 'Pinned' : 'Pin'}</Text>
      </TouchableOpacity>
    </View>
    {item.description ? <Text style={styles.cardDesc}>{item.description}</Text> : null}
    <TouchableOpacity onPress={() => router.push(`/feeds/${item._id || item.id}`)} style={{ marginTop: 8 }}>
      <Text style={{ color: colors.linkColor, fontWeight: '600' }}>Open feed</Text>
    </TouchableOpacity>
  </View>
);

const FeedsScreen: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const [pinned, setPinned] = useState<string[]>([]);
  const [myFeeds, setMyFeeds] = useState<any[]>([]);
  const [publicFeeds, setPublicFeeds] = useState<any[]>([]);
  const [_loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const stored = (await getData<string[]>(PINNED_KEY)) || [];
      setPinned(stored);
    })();
  }, []);

  useEffect(() => {
    const load = async () => {
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
    }
    load();
  }, []);

  const onTogglePin = useCallback(async (id: string) => {
    setPinned((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      // Persist async but do not block UI
      storeData(PINNED_KEY, next).catch(() => { });
      return next;
    });
  }, []);

  const filteredPublic = useMemo(() => {
    const q = query.trim().toLowerCase();
    const src = publicFeeds || [];
    if (!q) return src;
    return src.filter((f: any) => [f.title, f.description].filter(Boolean).some((s: string) => s.toLowerCase().includes(q)));
  }, [query, publicFeeds]);

  const pinnedObjects = useMemo(() => {
    const customPinned = myFeeds.filter((f: any) => pinned.includes(`custom:${f._id || f.id}`));
    return customPinned.map((f: any) => ({ id: `custom:${f._id || f.id}`, title: f.title, emoji: '🧩' }));
  }, [pinned, myFeeds]);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ThemedView style={styles.container}>
        <Header options={{
          title: t('Feeds'), rightComponents: [
            <TouchableOpacity key="create" onPress={() => router.push('/feeds/create')} style={{ padding: 8 }}>
              <Ionicons name="add-circle-outline" size={22} color={colors.primaryColor} />
            </TouchableOpacity>
          ]
        }} />

        {/* My Feeds */}
        <View style={styles.sectionHeaderRow}>
          <View style={styles.sectionHeaderIcon}>
            <Ionicons name="filter" size={18} color={colors.primaryLight} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.sectionTitle}>My Feeds</Text>
            <Text style={styles.sectionSub}>All the feeds you’ve saved, right in one place.</Text>
          </View>
        </View>

        <View style={styles.myFeedsBox}>
          <MyFeedsRow
            icon={<Ionicons name="people-outline" size={18} color={colors.primaryColor} />}
            label="Following"
            onPress={() => router.push('/')}
          />
          <MyFeedsRow
            icon={<Ionicons name="sparkles-outline" size={18} color={colors.primaryColor} />}
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
        <View style={[styles.sectionHeaderRow, { marginTop: 10 }]}>
          <View style={styles.sectionHeaderIcon}>
            <Ionicons name="options" size={18} color={colors.primaryLight} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.sectionTitle}>Discover New Feeds</Text>
            <Text style={styles.sectionSub}>
              Choose your own timeline! Feeds built by the community help you find
              content you love.
            </Text>
          </View>
        </View>

        <View style={styles.searchBox}>
          <Ionicons name="search" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
          <TextInput
            placeholder={t('Search feeds')}
            value={query}
            onChangeText={setQuery}
            style={styles.searchInput}
            placeholderTextColor={colors.COLOR_BLACK_LIGHT_5}
          />
        </View>

        <LegendList
          data={filteredPublic}
          keyExtractor={(item: any) => String(item._id || item.id)}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={{ paddingBottom: 30 }}
          renderItem={({ item }: { item: any }) => (
            <PublicFeedCard
              item={item}
              pinned={pinned.includes(`custom:${item._id || item.id}`)}
              onTogglePin={onTogglePin}
            />
          )}
          showsVerticalScrollIndicator={false}
          recycleItems={true}
          maintainVisibleContentPosition={true}
        />

        {/* Your Feeds */}
        <View style={[styles.sectionHeaderRow, { marginTop: 10 }]}>
          <View style={styles.sectionHeaderIcon}>
            <Ionicons name="person-circle" size={18} color={colors.primaryLight} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.sectionTitle}>Your Feeds</Text>
            <Text style={styles.sectionSub}>Custom timelines you created.</Text>
          </View>
        </View>
        {myFeeds.map((f: any) => (
          <View key={String(f._id || f.id)} style={styles.card}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={styles.cardEmojiBubble}><Text style={{ fontSize: 18 }}>🧩</Text></View>
              <View style={{ marginLeft: 10, flex: 1 }}>
                <Text style={styles.cardTitle}>{f.title}</Text>
                <Text style={styles.cardBy}>{(f.memberOxyUserIds || []).length} members • {f.isPublic ? 'Public' : 'Private'}</Text>
              </View>
              <TouchableOpacity onPress={() => onTogglePin(`custom:${f._id || f.id}`)} style={[styles.pinBtn, pinned.includes(`custom:${f._id || f.id}`) ? styles.pinBtnActive : undefined]}>
                <Ionicons name={pinned.includes(`custom:${f._id || f.id}`) ? 'pin' : 'pin-outline'} size={16} color={pinned.includes(`custom:${f._id || f.id}`) ? colors.primaryLight : colors.primaryColor} />
                <Text style={[styles.pinBtnText, pinned.includes(`custom:${f._id || f.id}`) ? { color: colors.primaryLight } : undefined]}>{pinned.includes(`custom:${f._id || f.id}`) ? 'Pinned' : 'Pin'}</Text>
              </TouchableOpacity>
            </View>
            {f.description ? <Text style={styles.cardDesc}>{f.description}</Text> : null}
            <TouchableOpacity onPress={() => router.push(`/feeds/${f._id || f.id}`)} style={{ marginTop: 8 }}>
              <Text style={{ color: colors.linkColor, fontWeight: '600' }}>Open feed</Text>
            </TouchableOpacity>
          </View>
        ))}

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
    backgroundColor: colors.primaryColor,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.COLOR_BLACK_LIGHT_1,
  },
  sectionSub: {
    fontSize: 13,
    color: colors.COLOR_BLACK_LIGHT_4,
    marginTop: 3,
  },
  myFeedsBox: {
    marginTop: 10,
    backgroundColor: colors.primaryLight,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
  },
  myFeedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
  },
  myFeedIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  myFeedLabel: {
    flex: 1,
    fontSize: 15,
    color: colors.COLOR_BLACK_LIGHT_1,
    fontWeight: '600',
  },
  searchBox: {
    marginHorizontal: 12,
    marginVertical: 12,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'web' ? 10 : 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
  },
  searchInput: {
    flex: 1,
    marginLeft: 8,
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_1,
    paddingVertical: 4,
  },
  card: {
    backgroundColor: colors.primaryLight,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
  },
  cardEmojiBubble: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.COLOR_BLACK_LIGHT_1,
  },
  cardBy: {
    marginTop: 2,
    fontSize: 12,
    color: colors.COLOR_BLACK_LIGHT_4,
  },
  cardDesc: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 18,
    color: colors.COLOR_BLACK_LIGHT_3,
  },
  cardLikes: {
    marginTop: 8,
    fontSize: 12,
    color: colors.COLOR_BLACK_LIGHT_5,
  },
  pinBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primaryLight,
    borderWidth: 1,
    borderColor: colors.primaryColor,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  pinBtnActive: {
    backgroundColor: colors.primaryColor,
    borderColor: colors.primaryColor,
  },
  pinBtnText: {
    marginLeft: 6,
    fontSize: 12,
    fontWeight: '700',
    color: colors.primaryColor,
  },
  separator: {
    height: 1,
    backgroundColor: colors.COLOR_BLACK_LIGHT_6,
  },
});
