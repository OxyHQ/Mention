import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { queryKeys, useAuth } from '@oxy.so/services/ui/client';
import { AccountAvatarGroup } from '@/components/ui/AccountAvatarGroup';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/** Real followed accounts, sharing the graph already seeded by the app root. */
export function FollowingAvatars() {
  const { oxyServices, user, canUsePrivateApi } = useAuth();
  const viewerId = user?.id ?? '';
  const enabled = canUsePrivateApi && viewerId.length > 0;
  const graph = useQuery({
    queryKey: viewerQueryKeys.viewerFollowing(viewerId),
    queryFn: () => oxyServices.follows.viewerGraph(),
    enabled,
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
  });
  const ids = enabled ? (graph.data?.followingIds.slice(0, 3) ?? []) : [];
  const profiles = useQuery({
    queryKey: queryKeys.users.list(ids),
    queryFn: () => oxyServices.users.getMany(ids),
    enabled: enabled && ids.length > 0,
    staleTime: 2 * 60 * 1000,
  });
  const accounts = profiles.data;
  if (!enabled || ids.length === 0 || !accounts) return null;
  const items = ids.flatMap((id) => {
    const account = accounts.find((profile) => profile.id === id);
    return account
      ? [
          {
            id,
            uri: account.avatar,
            kind: account.kind,
            character: account.character,
            color: account.color,
          },
        ]
      : [];
  });
  if (items.length === 0) return null;
  return (
    <View pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants">
      <AccountAvatarGroup
        items={items}
        size={18}
        overlap={6}
        max={3}
        ringWidth={0}
        testID="video-following-avatars"
      />
    </View>
  );
}
