import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import Avatar from '@/components/Avatar';
import { colors } from '@/styles/colors';
import { listsService } from '@/services/listsService';
// storage no longer used
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import SEO from '@/components/SEO';


const ListCard = ({ item }: { item: any }) => {
  const theme = useTheme();
  const owner = item.owner || item.createdBy || item.creator;
  const username = owner?.username || (owner?.handle) || '';
  return (
    <TouchableOpacity onPress={() => router.push(`/lists/${item._id || item.id}`)} style={styles.listRow}>
      <Avatar source={item.avatar || owner?.avatar} size={40} />
      <View style={{ marginLeft: 12, flex: 1 }}>
        <Text style={[styles.cardTitle, { color: theme.colors.text }]}>{item.title}</Text>
        <Text style={[styles.cardBy, { color: theme.colors.textSecondary }]}>{`List by ${username ? `@${username}` : (owner?.displayName || '')}`}</Text>
      </View>
      <View style={{ width: 56, alignItems: 'flex-end' }}>
        <Ionicons name="chevron-forward" size={22} color={theme.colors.textSecondary} />
      </View>
    </TouchableOpacity>
  );
};

export default function ListsScreen() {
  const [myLists, setMyLists] = useState<any[]>([]);
  const theme = useTheme();
  const { t } = useTranslation();


  useEffect(() => {
    (async () => {
      try {
        const mine = await listsService.list({ mine: true });
        setMyLists(mine.items || []);
      } catch (e) {
        console.warn('load lists failed', e);
      }
    })();
  }, []);





  return (
    <>
      <SEO
        title={t('seo.lists.title')}
        description={t('seo.lists.description')}
      />
      <ThemedView style={{ flex: 1 }}>
        <Header options={{
        title: 'Lists', 
        leftComponents: [
          <HeaderIconButton
            key="back"
            onPress={() => router.back()}
          >
            <BackArrowIcon size={20} color={theme.colors.text} />
          </HeaderIconButton>,
        ],
        rightComponents: [
          <TouchableOpacity key="create" onPress={() => router.push('/lists/create')} style={[styles.newPill, { backgroundColor: theme.colors.primary }]}>
            <Text style={[styles.newPillText, { color: theme.colors.card }]}>+ New</Text>
          </TouchableOpacity>
        ]
      }} 
      hideBottomBorder={true}
      disableSticky={true}
      />

      <View style={styles.content}>
        {myLists.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="list" size={64} color={theme.colors.border} />
            <Text style={[styles.emptyStateTitle, { color: theme.colors.text }]}>No lists yet</Text>
            <Text style={[styles.emptyStateDescription, { color: theme.colors.textSecondary }]}>Create a list to group accounts you follow and keep organized.</Text>
            <TouchableOpacity style={[styles.emptyStateButton, { backgroundColor: theme.colors.primary }]} onPress={() => router.push('/lists/create')}>
              <Text style={[styles.emptyStateButtonText, { color: theme.colors.card }]}>Create list</Text>
            </TouchableOpacity>
          </View>
        ) : (
          myLists.map((l) => (
            <ListCard key={String(l._id || l.id)} item={l} />
          ))
        )}
      </View>


    </ThemedView>
    </>
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
  // new styles
  listRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.COLOR_BLACK_LIGHT_6 },
  newBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.COLOR_BLACK_LIGHT_9 },
  newBtnText: { color: colors.primaryLight, fontWeight: '700' },
  content: { paddingHorizontal: 12, paddingTop: 10 },
  emptyText: { color: colors.COLOR_BLACK_LIGHT_4, fontSize: 15, padding: 18 },
  // pill in header
  newPill: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, backgroundColor: colors.primaryColor, alignItems: 'center', justifyContent: 'center' },
  newPillText: { color: colors.primaryLight, fontWeight: '700' },
  // empty state
  emptyState: { alignItems: 'center', paddingVertical: 36, paddingHorizontal: 20 },
  emptyStateTitle: { fontSize: 20, fontWeight: '700', color: colors.COLOR_BLACK_LIGHT_1, marginTop: 12 },
  emptyStateDescription: { fontSize: 14, color: colors.COLOR_BLACK_LIGHT_4, textAlign: 'center', marginTop: 8, lineHeight: 20 },
  emptyStateButton: { marginTop: 18, backgroundColor: colors.primaryColor, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20 },
  emptyStateButtonText: { color: colors.primaryLight, fontWeight: '700' },

});

