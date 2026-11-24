import { SupervisedFeatureGate } from '@/components/SupervisedFeatureGate';
import { useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { listsService, type MentionList } from '@/services/listsService';
import { entityFollowService } from '@/services/entityFollowService';
import { subscribeToListChanges } from '@/services/listMutations';
import { useRouter, useFocusEffect } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { SEO } from '@/components/SEO';
import { ListCard as ListCardComponent, type ListCardData } from '@/components/ListCard';
import { EmptyState } from '@/components/common/EmptyState';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { SignInRequired } from '@/components/common/SignInRequired';

import {
  Button as LButton,
  Embed,
  Header,
  RawText,
  ScrollView,
  Text as LText,
  VStack,
  toElement,
  Group,
} from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

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

const ListsScreen = screen(function ListsScreen() {
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

  // Resolve the viewer's follows in order. The service falls back to individual
  // reads on older backends and omits lists no longer visible to this viewer.
  const followedQueryKey = viewerQueryKeys.followedLists(viewerId);
  const followedQuery = useQuery<MentionList[]>({
    queryKey: followedQueryKey,
    enabled: canUsePrivateApi,
    queryFn: async () => {
      const follows = await entityFollowService.getFollowing('list', FOLLOWED_LIST_PAGE_SIZE);
      const ids = follows.items.map((f) => f.entityId);
      return listsService.resolve(ids);
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
      toElement(
        VStack(
          hasOwned
            ? VStack(
                RawText(t('lists.sections.yours', { defaultValue: 'Your lists' }))
                  .padding('horizontal', 'md')
                  .foreground('muted')
                  .font('xs')
                  .leading('16px')
                  .weight('semibold')
                  .textCase('uppercase')
                  .tracking('wide')
                  .margin('bottom', 'sm'),
                Embed(
                  ownedLists.map((l) =>
                    toElement(
                      VStack(
                        Embed(
                          <ListCardComponent
                            list={toListCardData(l)}
                            onPress={() => router.push(`/lists/${l._id || l.id}`)}
                          />,
                        ),
                      )
                        .padding('horizontal', 'md')
                        .margin('bottom', 'sm'),
                      String(l._id || l.id),
                    ),
                  ),
                ),
              ).margin('bottom', 'lg')
            : null,
          hasFollowed
            ? VStack(
                RawText(t('lists.sections.followed', { defaultValue: 'Followed lists' }))
                  .padding('horizontal', 'md')
                  .foreground('muted')
                  .font('xs')
                  .leading('16px')
                  .weight('semibold')
                  .textCase('uppercase')
                  .tracking('wide')
                  .margin('bottom', 'sm'),
                Embed(
                  followedLists.map((l) =>
                    toElement(
                      VStack(
                        Embed(
                          <ListCardComponent
                            list={toListCardData(l)}
                            onPress={() => router.push(`/lists/${l._id || l.id}`)}
                          />,
                        ),
                      )
                        .padding('horizontal', 'md')
                        .margin('bottom', 'sm'),
                      String(l._id || l.id),
                    ),
                  ),
                ),
              ).margin('bottom', 'sm')
            : null,
        )
          .padding('horizontal', 'xs')
          .padding('bottom', 'lg'),
      )
    );

  // The SEO tags draw nothing in place (the document's head on the web).
  return Group(
    Embed(<SEO title={t('seo.lists.title')} description={t('seo.lists.description')} />),
    Embed(
      <SignInRequired
        label={t('lists.signInRequired', { defaultValue: 'Sign in to use lists' })}
        description={t('lists.signInRequiredDesc', {
          defaultValue:
            'Lists group the accounts you want to read together. The ones you create or follow appear here.',
        })}
      >
        {toElement(
          ScrollView(Embed(content)).contentView((v) =>
            v.padding('horizontal', 'md').padding('top', '10'),
          ),
        )}
      </SignInRequired>,
    ),
  )
    .onReselect(refreshLists)
    .header(
      Header(t('lists.title'))
        .backLabel(t('common.back', { defaultValue: 'Back' }))
        .toolbar(
          Embed(
            canUsePrivateApi
              ? toElement(
                  LButton(LText(t('lists.new'))).onPress(() => router.push('/lists/create')),
                )
              : undefined,
          ),
        )
        .inPage(),
    );
});

export default function AvailableListsScreen() {
  return (
    <SupervisedFeatureGate>
      <ListsScreen />
    </SupervisedFeatureGate>
  );
}
