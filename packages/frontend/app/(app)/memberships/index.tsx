import { Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { useIsFocused, useRouter } from '@/lib/navigation/router';
import { SignInRequired } from '@/components/common/SignInRequired';
import { EmptyState } from '@/components/common/EmptyState';
import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { membershipsService } from '@/services/membershipsService';
import { membershipKeys, membershipQueryPolicy } from '@/components/Memberships/membershipQueries';

export default function MembershipsScreen() {
  const { user, canUsePrivateApi } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const focused = useIsFocused();
  const query = useQuery({
    ...membershipQueryPolicy,
    queryKey: membershipKeys.mine(user?.id),
    queryFn: ({ signal }) => membershipsService.mine(signal),
    enabled: canUsePrivateApi && focused,
  });
  const header = (
    <PageHeader
      title={t('memberships.title', 'Memberships')}
      onBack={() => router.back()}
      actions={
        canUsePrivateApi ? (
          <Button size="sm" onPress={() => router.push('/memberships/create')}>
            {t('memberships.create', 'Create community')}
          </Button>
        ) : undefined
      }
    />
  );
  if (!canUsePrivateApi)
    return (
      <Screen header={header}>
        <SignInRequired
          label={t('memberships.signIn', 'Sign in to join a community')}
          description={t(
            'memberships.privateHelp',
            'Only authorized members can read community posts and files.',
          )}
        />
      </Screen>
    );
  return (
    <Screen header={header}>
      <ScreenScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {query.isPending || query.isFetching ? (
          <ListSkeleton />
        ) : query.isError ? (
          <EmptyState
            error={{
              title: t('memberships.unavailable', 'Communities unavailable'),
              message: t('memberships.retry', 'Try again to check your access.'),
              onRetry: async () => {
                await query.refetch();
              },
            }}
          />
        ) : focused && query.data ? (
          <>
            {(
              [
                ['owned', t('memberships.owned', 'Your communities')],
                ['joined', t('memberships.joined', 'Joined communities')],
              ] as const
            ).map(([key, label]) => (
              <View key={key} className="gap-3">
                <Text className="text-lg font-semibold text-foreground">{label}</Text>
                {query.data[key].length ? (
                  query.data[key].map((community) => (
                    <Card key={community.id}>
                      <View className="p-4 gap-2">
                        <Text className="text-lg font-semibold text-foreground">
                          {community.name}
                        </Text>
                        <Text className="text-muted-foreground">{community.description}</Text>
                        <Button
                          appearance="outline"
                          onPress={() => router.push(`/memberships/${community.id}`)}
                        >
                          {t('memberships.open', 'Open community')}
                        </Button>
                      </View>
                    </Card>
                  ))
                ) : (
                  <Text className="text-muted-foreground">
                    {t('memberships.empty', 'No communities yet.')}
                  </Text>
                )}
              </View>
            ))}
          </>
        ) : null}
      </ScreenScrollView>
    </Screen>
  );
}
