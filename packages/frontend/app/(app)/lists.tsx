import { SupervisedFeatureGate } from '@/components/SupervisedFeatureGate';
import { useCallback, useEffect } from 'react';
import { View, Text } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { listsService, type MentionList } from '@/services/listsService';
import { entityFollowService } from '@/services/entityFollowService';
import { subscribeToListChanges } from '@/services/listMutations';
import { useRouter, useFocusEffect } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { SEO } from '@/components/SEO';
import { ListCard as ListCardComponent, type ListCardData } from '@/components/ListCard';
import { EmptyState } from '@/components/common/EmptyState';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { ScreenReselect } from '@/components/common/ScreenReselect';
import { SignInRequired } from '@/components/common/SignInRequired';

const FOLLOWED_LIST_PAGE_SIZE = 50;

function toListCardData(list: MentionList): ListCardData {
  const owner = list.owner;
  return {
    id: String(list._id || list.id),
    uri: `list:${list._id || list.id}`,
    name: list.title || 'Untitled List',
    description: list.description,
    creator: owner
      ? {
          username: owner.username || '',
          displayName: owner.displayName,
          avatar: owner.avatar,
        }
      : undefined,
    purpose: list.purpose === 'modlist' ? 'modlist' : 'curatelist',
    itemCount: list.memberCount ?? list.memberOxyUserIds?.length ?? 0,
    subscriberCount: typeof list.subscriberCount === 'number' ? list.subscriberCount : 0,
  };
}

function ListsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { canUsePrivateApi, user } = useAuth();
  const viewerId = user?.id;
  const queryClient = useQueryClient();

  // Identity-keyed so the collections (re)load when the session resolves on cold
  // boot. Keying on the auth identity — not `[]` — means an anonymous-then-signed-in
  // transition refetches instead of staying frozen at the empty anonymous result.
  const ownedQueryKey = viewerQueryKeys.ownedLists(viewerId);
  const ownedQuery = useQuery<MentionList[]>({
    queryKey: ownedQueryKey,
    enabled: canUsePrivateApi,
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
  const followedQueryKey = viewerQueryKeys.followedLists(viewerId);
  const followedQuery = useQuery<MentionList[]>({
    queryKey: followedQueryKey,
    enabled: canUsePrivateApi,
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
  const refreshLists = useCallback(
    () => queryClient.invalidateQueries({ queryKey: viewerQueryKeys.listsRoot(viewerId) }),
    [queryClient, viewerId],
  );
  // Refresh both collections when a list is created/renamed/deleted anywhere
  // (membership/metadata changes broadcast through notifyListChanged).
  useEffect(() => subscribeToListChanges(refreshLists), [refreshLists]);

  // The follow/unfollow toggle lives on the list detail screen and updates the
  // shared entity-follow store rather than the list collection. Returning to
  // this screen re-validates the followed collection so a list just followed
  // (or unfollowed) appears/disappears without a manual reload.
  useFocusEffect(
    useCallback(() => {
      if (canUsePrivateApi) {
        queryClient.invalidateQueries({ queryKey: viewerQueryKeys.followedLists(viewerId) });
      }
    }, [canUsePrivateApi, queryClient, viewerId]),
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
  const content =
    !hasOwned && !hasFollowed ? (
      <EmptyState
        title={t('lists.empty.title')}
        subtitle={t('lists.empty.subtitle')}
        sticker="lists"
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
      <SEO title={t('seo.lists.title')} description={t('seo.lists.description')} />
      <Screen
        header={
          <PageHeader
            title={t('lists.title')}
            backLabel={t('common.back', { defaultValue: 'Back' })}
            actions={
              canUsePrivateApi ? (
                <Button size="sm" onPress={() => router.push('/lists/create')}>
                  {t('lists.new')}
                </Button>
              ) : undefined
            }
          />
        }
      >
        <ScreenReselect refresh={refreshLists} />
        <SignInRequired
          label={t('lists.signInRequired', { defaultValue: 'Sign in to use lists' })}
          description={t('lists.signInRequiredDesc', {
            defaultValue:
              'Lists group the accounts you want to read together. The ones you create or follow appear here.',
          })}
        >
          <ScreenScrollView
            showsVerticalScrollIndicator={false}
            contentContainerClassName="px-3 pt-2.5"
          >
            {content}
          </ScreenScrollView>
        </SignInRequired>
      </Screen>
    </>
  );
}

export default function AvailableListsScreen() {
  return (
    <SupervisedFeatureGate>
      <ListsScreen />
    </SupervisedFeatureGate>
  );
}
