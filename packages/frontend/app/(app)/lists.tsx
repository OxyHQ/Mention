import React, { useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { listsService, type MentionList } from '@/services/listsService';
import { entityFollowService } from '@/services/entityFollowService';
import { subscribeToListChanges } from '@/services/listMutations';
import { router, useFocusEffect } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import SEO from '@/components/SEO';
import { ListCard as ListCardComponent, type ListCardData } from '@/components/ListCard';
import { EmptyState } from '@/components/common/EmptyState';
import { List } from '@/assets/icons/list-icon';

const FOLLOWED_LIST_PAGE_SIZE = 50;

const IS_WEB = Platform.OS === 'web';

function toListCardData(list: MentionList): ListCardData {
  const owner = list.owner;
  return {
    id: String(list._id || list.id),
    uri: `list:${list._id || list.id}`,
    name: list.title || 'Untitled List',
    description: list.description,
    avatar: typeof list.avatar === 'string' ? list.avatar : undefined,
    creator: owner
      ? {
          username: owner.username || '',
          displayName: owner.displayName,
          avatar: owner.avatar,
        }
      : undefined,
    purpose: list.purpose === 'modlist' ? 'modlist' : 'curatelist',
    itemCount: list.memberCount ?? (list.memberOxyUserIds?.length ?? 0),
    subscriberCount: typeof list.subscriberCount === 'number' ? list.subscriberCount : 0,
  };
}

export default function ListsScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { isAuthenticated, user } = useAuth();
  const viewerId = user?.id;
  const queryClient = useQueryClient();

  // Identity-keyed so the collections (re)load when the session resolves on cold
  // boot. Keying on the auth identity — not `[]` — means an anonymous-then-signed-in
  // transition refetches instead of staying frozen at the empty anonymous result.
  const ownedQueryKey = ['lists', 'owned', viewerId ?? 'anon'] as const;
  const ownedQuery = useQuery<MentionList[]>({
    queryKey: ownedQueryKey,
    enabled: isAuthenticated,
    queryFn: async () => {
      const res = await listsService.list({ mine: true });
      return res.items ?? [];
    },
  });

  // Followed lists: resolve the viewer's `list` entity-follows into full list
  // DTOs. There is no batch list-by-ids endpoint, so each followed id is
  // resolved individually; a deleted/private followed list resolves to null and
  // is dropped. The resolution is part of the query so React Query owns its
  // cache, dedupe, and identity-keyed refetch — no mount-only effect.
  const followedQueryKey = ['lists', 'followed', viewerId ?? 'anon'] as const;
  const followedQuery = useQuery<MentionList[]>({
    queryKey: followedQueryKey,
    enabled: isAuthenticated,
    queryFn: async () => {
      const follows = await entityFollowService.getFollowing('list', FOLLOWED_LIST_PAGE_SIZE);
      const ids = follows.items.map((f) => f.entityId);
      const resolved = await Promise.all(
        ids.map(async (id) => {
          try {
            return await listsService.get(id);
          } catch {
            // A followed list that no longer resolves (deleted/private) is
            // simply omitted from the section rather than failing the query.
            return null;
          }
        }),
      );
      return resolved.filter((l): l is MentionList => l !== null);
    },
  });

  // Refresh both collections when a list is created/renamed/deleted anywhere
  // (membership/metadata changes broadcast through notifyListChanged).
  useEffect(() => {
    return subscribeToListChanges(() => {
      queryClient.invalidateQueries({ queryKey: ['lists'] });
    });
  }, [queryClient]);

  // The follow/unfollow toggle lives on the list detail screen and updates the
  // shared entity-follow store rather than the list collection. Returning to
  // this screen re-validates the followed collection so a list just followed
  // (or unfollowed) appears/disappears without a manual reload.
  useFocusEffect(
    useCallback(() => {
      if (isAuthenticated) {
        queryClient.invalidateQueries({ queryKey: ['lists', 'followed'] });
      }
    }, [isAuthenticated, queryClient]),
  );

  const ownedLists = ownedQuery.data ?? [];
  const ownedIds = new Set(ownedLists.map((l) => String(l._id || l.id)));
  // De-dup: a list the viewer both owns and follows shows only under "Your lists".
  const followedLists = (followedQuery.data ?? []).filter(
    (l) => !ownedIds.has(String(l._id || l.id)),
  );

  const hasOwned = ownedLists.length > 0;
  const hasFollowed = followedLists.length > 0;

  // Directory body — identical on both platforms; only the scroll host differs.
  const content = !hasOwned && !hasFollowed ? (
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
    <View className="px-1 pb-4">
      {hasOwned ? (
        <View className="mb-4">
          <Text className="text-muted-foreground text-xs font-semibold uppercase tracking-wide px-3 mb-2">
            {t('lists.sections.yours', { defaultValue: 'Your lists' })}
          </Text>
          {ownedLists.map((l) => (
            <View key={String(l._id || l.id)} className="px-3 mb-2">
              <ListCardComponent
                list={toListCardData(l)}
                onPress={() => router.push(`/lists/${l._id || l.id}`)}
              />
            </View>
          ))}
        </View>
      ) : null}

      {hasFollowed ? (
        <View className="mb-2">
          <Text className="text-muted-foreground text-xs font-semibold uppercase tracking-wide px-3 mb-2">
            {t('lists.sections.followed', { defaultValue: 'Followed lists' })}
          </Text>
          {followedLists.map((l) => (
            <View key={String(l._id || l.id)} className="px-3 mb-2">
              <ListCardComponent
                list={toListCardData(l)}
                onPress={() => router.push(`/lists/${l._id || l.id}`)}
              />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );

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

        {/* WEB: the document (body) is the scroller — the shell owns scroll, so
            the directory renders in normal flow. A ScrollView here would nest a
            second scroll container inside the ContentPanel and break the sticky
            side rails, window scroll-restoration and bottom-bar auto-hide.
            NATIVE: a ScrollView is the correct screen scroller. */}
        {IS_WEB ? (
          <View className="px-3 pt-2.5">{content}</View>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false} className="px-3 pt-2.5">
            {content}
          </ScrollView>
        )}
      </ThemedView>
    </>
  );
}
