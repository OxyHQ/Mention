import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { listsService } from '@/services/listsService';
import { router } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import SEO from '@/components/SEO';
import { ListCard as ListCardComponent, type ListCardData } from '@/components/ListCard';
import { EmptyState } from '@/components/common/EmptyState';
import { List } from '@/assets/icons/list-icon';
import { logger } from '@/lib/logger';

export default function ListsScreen() {
  const [myLists, setMyLists] = useState<any[]>([]);
  const { t } = useTranslation();
  const safeBack = useSafeBack();

  useEffect(() => {
    (async () => {
      try {
        const mine = await listsService.list({ mine: true });
        setMyLists(mine.items || []);
      } catch (e) {
        logger.warn('load lists failed', { error: e });
      }
    })();
  }, []);

  return (
    <>
      <SEO
        title={t('seo.lists.title')}
        description={t('seo.lists.description')}
      />
      <ThemedView className="flex-1">
        <Header options={{
          title: t('lists.title'),
          leftComponents: [
            <IconButton variant="icon"
              key="back"
              onPress={safeBack}
            >
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
          rightComponents: [
            <TouchableOpacity key="create" onPress={() => router.push('/lists/create')} className="px-3.5 py-1.5 rounded-full items-center justify-center bg-primary">
              <Text className="font-bold text-primary-foreground">{t('lists.new')}</Text>
            </TouchableOpacity>
          ]
        }}
        hideBottomBorder={true}
        disableSticky={true}
        />

        <ScrollView showsVerticalScrollIndicator={false} className="px-3 pt-2.5">
          {myLists.length === 0 ? (
            <EmptyState
              title={t('lists.empty.title')}
              subtitle={t('lists.empty.subtitle')}
              customIcon={<List size={48} className="text-muted-foreground" />}
              action={{
                label: t('lists.createList'),
                onPress: () => router.push('/lists/create'),
              }}
              containerStyle={{ paddingVertical: 36, paddingHorizontal: 20 }}
            />
          ) : (
            <View className="px-1">
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
                  <View key={String(l._id || l.id)} className="px-3 mb-2">
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
