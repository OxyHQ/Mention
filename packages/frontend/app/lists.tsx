import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { colors } from '@/styles/colors';
import { listsService } from '@/services/listsService';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import SEO from '@/components/SEO';
import { ListCard as ListCardComponent, type ListCardData } from '@/components/ListCard';
import { EmptyState } from '@/components/common/EmptyState';

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
          <IconButton variant="icon"
            key="back"
            onPress={() => router.back()}
          >
            <BackArrowIcon size={20} color={theme.colors.text} />
          </IconButton>,
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

      <ScrollView showsVerticalScrollIndicator={false} style={styles.content}>
        {myLists.length === 0 ? (
          <EmptyState
            title="No lists yet"
            subtitle="Create a list to group accounts you follow and keep organized."
            icon={{
              name: 'list',
              size: 48,
            }}
            action={{
              label: 'Create list',
              onPress: () => router.push('/lists/create'),
            }}
            containerStyle={styles.emptyState}
          />
        ) : (
          <View style={styles.listsContainer}>
            {myLists.map((l: any) => {
              const owner = l.owner || l.createdBy || l.creator;
              const listData: ListCardData = {
                id: String(l._id || l.id),
                uri: l.uri || `list:${l._id || l.id}`,
                name: l.title || 'Untitled List',
                description: l.description,
                avatar: l.avatar,
                creator: owner ? {
                  username: owner.username || owner.handle || '',
                  displayName: owner.displayName,
                  avatar: owner.avatar,
                } : undefined,
                purpose: l.purpose === 'modlist' ? 'modlist' : 'curatelist',
                itemCount: l.itemCount || l.memberCount || 0,
              };

              return (
                <View key={String(l._id || l.id)} style={styles.listCardWrapper}>
                  <ListCardComponent
                    list={listData}
                    onPress={() => router.push(`/lists/${l._id || l.id}`)}
                  />
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>


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
  listsContainer: {
    paddingHorizontal: 4,
  },
  listCardWrapper: {
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  newBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.COLOR_BLACK_LIGHT_9 },
  newBtnText: { color: colors.primaryLight, fontWeight: '700' },
  content: { paddingHorizontal: 12, paddingTop: 10 },
  emptyText: { color: colors.COLOR_BLACK_LIGHT_4, fontSize: 15, padding: 18 },
  // pill in header
  newPill: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, backgroundColor: colors.primaryColor, alignItems: 'center', justifyContent: 'center' },
  newPillText: { color: colors.primaryLight, fontWeight: '700' },
  // empty state
  emptyState: { paddingVertical: 36, paddingHorizontal: 20 },

});

