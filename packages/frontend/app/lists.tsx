import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TextInput, FlatList, TouchableOpacity, Platform } from 'react-native';
import { Header } from '@/components/Header';
import { colors } from '@/styles/colors';
import { listsService } from '@/services/listsService';
import { getData, storeData } from '@/utils/storage';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

const PINNED_KEY = 'mention.pinnedFeeds';

const ListCard = ({ item, pinned, onTogglePin }: { item: any; pinned: boolean; onTogglePin: (id: string) => void }) => (
  <View style={styles.card}>
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <View style={styles.cardEmojiBubble}><Text style={{ fontSize: 18 }}>📜</Text></View>
      <View style={{ marginLeft: 10, flex: 1 }}>
        <Text style={styles.cardTitle}>{item.title}</Text>
        <Text style={styles.cardBy}>{(item.memberOxyUserIds || []).length} members • {item.isPublic ? 'Public' : 'Private'}</Text>
      </View>
      <TouchableOpacity onPress={() => onTogglePin(`list:${item._id || item.id}`)} style={[styles.pinBtn, pinned ? styles.pinBtnActive : undefined]}>
        <Ionicons name={pinned ? 'pin' : 'pin-outline'} size={16} color={pinned ? colors.primaryLight : colors.primaryColor} />
        <Text style={[styles.pinBtnText, pinned ? { color: colors.primaryLight } : undefined]}>{pinned ? 'Pinned' : 'Pin'}</Text>
      </TouchableOpacity>
    </View>
    {item.description ? <Text style={styles.cardDesc}>{item.description}</Text> : null}
    <TouchableOpacity onPress={() => router.push(`/lists/${item._id || item.id}`)} style={{ marginTop: 8 }}>
      <Text style={{ color: colors.linkColor, fontWeight: '600' }}>Open list</Text>
    </TouchableOpacity>
  </View>
);

export default function ListsScreen() {
  const [query, setQuery] = useState('');
  const [myLists, setMyLists] = useState<any[]>([]);
  const [publicLists, setPublicLists] = useState<any[]>([]);
  const [pinned, setPinned] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      setPinned((await getData<string[]>(PINNED_KEY)) || []);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const mine = await listsService.list({ mine: true });
        setMyLists(mine.items || []);
        const pub = await listsService.list({ publicOnly: true });
        const mineIds = new Set((mine.items || []).map((l: any) => String(l._id || l.id)));
        setPublicLists((pub.items || []).filter((l: any) => !mineIds.has(String(l._id || l.id))));
      } catch (e) {
        console.warn('load lists failed', e);
      }
    })();
  }, []);

  const onTogglePin = useCallback(async (id: string) => {
    setPinned((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      storeData(PINNED_KEY, next).catch(() => {});
      return next;
    });
  }, []);

  const filteredPublic = useMemo(() => {
    const q = query.trim().toLowerCase();
    const src = publicLists || [];
    if (!q) return src;
    return src.filter((l: any) => [l.title, l.description].filter(Boolean).some((s: string) => s.toLowerCase().includes(q)));
  }, [query, publicLists]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.primaryLight }}>
      <Header options={{ title: 'Lists', rightComponents: [
        <TouchableOpacity key="create" onPress={() => router.push('/lists/create')} style={{ padding: 8 }}>
          <Ionicons name="add-circle-outline" size={22} color={colors.primaryColor} />
        </TouchableOpacity>
      ] }} />

      <View style={styles.sectionHeaderRow}>
        <View style={styles.sectionHeaderIcon}><Text style={{ color: colors.primaryLight }}>📜</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>Your Lists</Text>
          <Text style={styles.sectionSub}>Collections of accounts you curate.</Text>
        </View>
      </View>
      {myLists.map((l) => (
        <ListCard key={String(l._id || l.id)} item={l} pinned={pinned.includes(`list:${l._id || l.id}`)} onTogglePin={onTogglePin} />
      ))}

      <View style={[styles.sectionHeaderRow, { marginTop: 12 }]}>
        <View style={styles.sectionHeaderIcon}><Text style={{ color: colors.primaryLight }}>🌐</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>Discover Lists</Text>
          <Text style={styles.sectionSub}>Community lists you can browse and pin.</Text>
        </View>
      </View>

      <View style={styles.searchBox}>
        <Ionicons name="search" size={18} color={colors.COLOR_BLACK_LIGHT_4} />
        <TextInput
          placeholder={'Search lists'}
          value={query}
          onChangeText={setQuery}
          style={styles.searchInput}
          placeholderTextColor={colors.COLOR_BLACK_LIGHT_5}
        />
      </View>

      <FlatList
        data={filteredPublic}
        keyExtractor={(item: any) => String(item._id || item.id)}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={{ paddingBottom: 30 }}
        renderItem={({ item }) => (
          <ListCard item={item} pinned={pinned.includes(`list:${item._id || item.id}`)} onTogglePin={onTogglePin} />
        )}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 16 },
  sectionHeaderIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primaryColor, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  sectionTitle: { fontSize: 20, fontWeight: '800', color: colors.COLOR_BLACK_LIGHT_1 },
  sectionSub: { fontSize: 13, color: colors.COLOR_BLACK_LIGHT_4, marginTop: 3 },
  card: { backgroundColor: colors.primaryLight, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12 },
  cardEmojiBubble: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.COLOR_BLACK_LIGHT_8, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.COLOR_BLACK_LIGHT_1 },
  cardBy: { marginTop: 2, fontSize: 12, color: colors.COLOR_BLACK_LIGHT_4 },
  cardDesc: { marginTop: 10, fontSize: 13, lineHeight: 18, color: colors.COLOR_BLACK_LIGHT_3 },
  pinBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primaryLight, borderWidth: 1, borderColor: colors.primaryColor, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
  pinBtnActive: { backgroundColor: colors.primaryColor, borderColor: colors.primaryColor },
  pinBtnText: { marginLeft: 6, fontSize: 12, fontWeight: '700', color: colors.primaryColor },
  separator: { height: 1, backgroundColor: colors.COLOR_BLACK_LIGHT_6 },
  searchBox: { marginHorizontal: 12, marginVertical: 12, paddingHorizontal: 12, paddingVertical: Platform.OS === 'web' ? 10 : 8, flexDirection: 'row', alignItems: 'center', borderRadius: 10, backgroundColor: colors.COLOR_BLACK_LIGHT_8, borderWidth: 1, borderColor: colors.COLOR_BLACK_LIGHT_6 },
  searchInput: { flex: 1, marginLeft: 8, fontSize: 14, color: colors.COLOR_BLACK_LIGHT_1, paddingVertical: 4 },
});

