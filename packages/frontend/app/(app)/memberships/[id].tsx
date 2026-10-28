import { MembershipDirectory } from '@/components/Memberships/MembershipDirectory';
import { MembershipTierEditor } from '@/components/Memberships/MembershipTierEditor';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useIsFocused, useLocalSearchParams, useRouter } from '@/lib/navigation/router';
import { SignInRequired } from '@/components/common/SignInRequired';
import { EmptyState } from '@/components/common/EmptyState';
import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { membershipsService } from '@/services/membershipsService';
import { getErrorMessage } from '@/utils/apiError';
import { confirmDestructive } from '@/utils/alerts';
import {
  canReadMembership,
  hasCurrentMembership,
  membershipKeys,
  membershipQueryPolicy,
} from '@/components/Memberships/membershipQueries';
import { MembershipContentCard } from '@/components/Memberships/MembershipContentCard';
import { MembershipComposer } from '@/components/Memberships/MembershipComposer';
import type { MembershipCommunity, MembershipLandingResponse } from '@mention/shared-types';

export default function MembershipCommunityScreen() {
  const params = useLocalSearchParams<{ id: string; thread?: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const thread = typeof params.thread === 'string' ? params.thread : undefined;
  const { user, canUsePrivateApi } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const focused = useIsFocused();
  const cache = useQueryClient();
  const [manage, setManage] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const landing = useQuery({
    ...membershipQueryPolicy,
    queryKey: membershipKeys.landing(user?.id, id, canUsePrivateApi),
    queryFn: ({ signal }) => membershipsService.landing(id, signal),
    enabled: focused && !!id,
  });
  const readable =
    !!landing.data &&
    canReadMembership(landing.data) &&
    !landing.isError &&
    !landing.isFetching &&
    canUsePrivateApi &&
    !leaving &&
    focused;
  const contents = useInfiniteQuery({
    ...membershipQueryPolicy,
    queryKey: membershipKeys.content(user?.id, id, thread),
    queryFn: ({ signal, pageParam }) => membershipsService.content(id, pageParam, thread, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: readable,
  });
  const parent = useQuery({
    ...membershipQueryPolicy,
    queryKey: membershipKeys.thread(user?.id, id, thread),
    queryFn: ({ signal }) => membershipsService.readContent(thread ?? '', signal),
    enabled: readable && !!thread,
  });
  const teaser = useQuery({
    ...membershipQueryPolicy,
    queryKey: membershipKeys.teaser(user?.id, id, thread),
    queryFn: ({ signal }) => membershipsService.teaser(thread ?? '', signal),
    enabled: focused && !!thread && !readable && !!landing.data,
  });
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: membershipKeys.community(user?.id, id) });
  };
  const mutation = useMutation({
    mutationFn: (operation: () => Promise<unknown>) => operation(),
    onSuccess: refresh,
  });
  const leave = async () => {
    if (
      !(await confirmDestructive(
        t('memberships.leave', 'Leave community?'),
        t('memberships.leaveHelp', 'You will lose access to member content immediately.'),
        t('memberships.leaveAction', 'Leave community'),
        t('common.cancel', 'Cancel'),
      ))
    )
      return;
    setLeaving(true);
    // Cancel pending bodies before changing entitlement, then discard every protected page.
    await cache.cancelQueries({ queryKey: membershipKeys.community(user?.id, id) });
    cache.removeQueries({ queryKey: membershipKeys.community(user?.id, id) });
    try {
      await mutation.mutateAsync(() => membershipsService.leave(id));
    } catch {
      // Mutation state renders the error; keep the account-scoped refresh path usable.
    } finally {
      setLeaving(false);
    }
  };
  const header = (
    <PageHeader
      title={landing.data?.community.name ?? t('memberships.title', 'Memberships')}
      onBack={() => router.back()}
      actions={
        landing.data?.canManage ? (
          <Button appearance="plain" onPress={() => setManage(!manage)}>
            {t('memberships.manage', 'Manage')}
          </Button>
        ) : undefined
      }
    />
  );
  return (
    <Screen header={header}>
      <ScreenScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {landing.isPending || landing.isFetching ? (
          <ListSkeleton />
        ) : landing.isError ? (
          <EmptyState
            error={{
              title: t('memberships.unavailable', 'Community unavailable'),
              message: t('memberships.retry', 'Try again to check your access.'),
              onRetry: async () => {
                await landing.refetch();
              },
            }}
          />
        ) : landing.data && focused ? (
          <>
            <Card>
              <View className="p-4 gap-3">
                <Text className="text-foreground">{landing.data.community.description}</Text>
                <Text className="text-muted-foreground">
                  {t(
                    'memberships.privateHelp',
                    'Only authorized members can read community posts and files.',
                  )}
                </Text>
                {!canUsePrivateApi ? (
                  <SignInRequired
                    label={t('memberships.signIn', 'Sign in to join a community')}
                    description={t(
                      'memberships.privateHelp',
                      'Only authorized members can read community posts and files.',
                    )}
                  />
                ) : hasCurrentMembership(landing.data.membership) && landing.data.membership ? (
                  <>
                    <Button
                      appearance="outline"
                      disabled={mutation.isPending}
                      onPress={() =>
                        mutation.mutate(() =>
                          membershipsService.badge(id, !landing.data?.membership?.publicBadge),
                        )
                      }
                    >
                      {landing.data.membership.publicBadge
                        ? t('memberships.hideBadge', 'Hide my membership badge')
                        : t('memberships.showBadge', 'Show my membership publicly')}
                    </Button>
                    <Button
                      appearance="plain"
                      disabled={mutation.isPending}
                      onPress={() => {
                        void leave();
                      }}
                    >
                      {t('memberships.leaveAction', 'Leave community')}
                    </Button>
                  </>
                ) : !readable && landing.data.community.status === 'active' ? (
                  landing.data.tiers
                    .filter((tier) => tier.kind === 'free' && tier.status === 'active')
                    .map((tier) => (
                      <Button
                        key={tier.id}
                        loading={mutation.isPending}
                        disabled={landing.data?.membership?.state === 'revoked'}
                        onPress={() => mutation.mutate(() => membershipsService.join(id, tier.id))}
                      >
                        {t('memberships.joinFree', 'Join free')}
                      </Button>
                    ))
                ) : null}
                {landing.data.membership?.state === 'revoked' ? (
                  <Text className="text-muted-foreground">
                    {t('memberships.revoked', 'Your membership has been revoked.')}
                  </Text>
                ) : null}
              </View>
            </Card>
            {mutation.isError ? (
              <Text accessibilityRole="alert" className="text-destructive">
                {getErrorMessage(
                  mutation.error,
                  t('memberships.failed', 'The action could not be completed.'),
                )}
              </Text>
            ) : null}
            {['active', 'paused'].includes(landing.data.community.status) ? (
              <MembershipDirectory communityId={id} />
            ) : null}
            {manage && landing.data.canManage ? (
              <MembershipManagement
                key={`${id}:${user?.id}`}
                landing={landing.data}
                viewerId={user?.id ?? ''}
                onChange={refresh}
              />
            ) : null}
            {!readable && teaser.isSuccess && !teaser.isFetching && teaser.data.teaser ? (
              <Card>
                <View className="p-4 gap-2">
                  <Text className="text-muted-foreground">
                    {t('memberships.publicTeaser', 'Public teaser')}
                  </Text>
                  <Text className="text-foreground">{teaser.data.teaser}</Text>
                </View>
              </Card>
            ) : null}
            {readable && user ? (
              <>
                {thread ? (
                  <Button appearance="plain" onPress={() => router.replace(`/memberships/${id}`)}>
                    {t('memberships.allPosts', 'All community posts')}
                  </Button>
                ) : null}
                {parent.isError ? (
                  <EmptyState
                    title={t('memberships.contentUnavailable', 'This content is unavailable.')}
                  />
                ) : thread && parent.data && !parent.isFetching ? (
                  <MembershipContentCard
                    content={parent.data}
                    viewerId={user.id}
                    manager={landing.data.canManage}
                    benefits={landing.data.viewerBenefits}
                    onChange={refresh}
                  />
                ) : null}
                {landing.data.viewerBenefits.includes('discussion_write') &&
                (!thread || (parent.data && !parent.isError && !parent.isFetching)) ? (
                  <MembershipComposer
                    key={`${id}:${thread ?? 'root'}:${user.id}`}
                    communityId={id}
                    parentContentId={thread}
                    manager={landing.data.canManage}
                    tiers={landing.data.tiers}
                    onCreated={refresh}
                  />
                ) : null}
                {contents.isPending || (contents.isFetching && !contents.isFetchingNextPage) ? (
                  <ListSkeleton />
                ) : contents.isError ? (
                  <EmptyState
                    error={{
                      title: t('memberships.contentUnavailable', 'Member content unavailable'),
                      message: t('memberships.retry', 'Try again to check your access.'),
                      onRetry: async () => {
                        await refresh();
                      },
                    }}
                  />
                ) : (
                  contents.data?.pages.map((page) =>
                    page.items.map((content) => (
                      <MembershipContentCard
                        key={content.id}
                        content={content}
                        viewerId={user.id}
                        manager={landing.data.canManage}
                        benefits={landing.data.viewerBenefits}
                        onChange={refresh}
                        onThread={() =>
                          router.push({
                            pathname: '/memberships/[id]',
                            params: { id, thread: content.id },
                          })
                        }
                      />
                    )),
                  )
                )}
                {contents.hasNextPage ? (
                  <Button
                    appearance="outline"
                    loading={contents.isFetchingNextPage}
                    onPress={() => {
                      void contents.fetchNextPage();
                    }}
                  >
                    {t('common.loadMore', 'Load more')}
                  </Button>
                ) : null}
              </>
            ) : !canUsePrivateApi ? null : (
              <EmptyState
                title={t('memberships.locked', 'Content is for members')}
                subtitle={t(
                  'memberships.lockedHelp',
                  'Join an available tier to read and participate.',
                )}
              />
            )}
          </>
        ) : null}
      </ScreenScrollView>
    </Screen>
  );
}

function MembershipManagement({
  landing,
  viewerId,
  onChange,
}: {
  landing: MembershipLandingResponse;
  viewerId: string;
  onChange: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(landing.community.name);
  const [description, setDescription] = useState(landing.community.description);
  const [visibility, setVisibility] = useState(landing.community.visibility);
  const mutation = useMutation({
    mutationFn: (patch: Partial<MembershipCommunity>) =>
      membershipsService.update(landing.community.id, patch),
    onSuccess: onChange,
  });
  const insights = useQuery({
    ...membershipQueryPolicy,
    queryKey: membershipKeys.insights(viewerId, landing.community.id),
    queryFn: ({ signal }) => membershipsService.insights(landing.community.id, signal),
  });
  const reports = useQuery({
    ...membershipQueryPolicy,
    queryKey: membershipKeys.reports(viewerId, landing.community.id),
    queryFn: ({ signal }) => membershipsService.reports(landing.community.id, signal),
  });
  const resolution = useMutation({
    mutationFn: (reportId: string) =>
      membershipsService.resolveReport(landing.community.id, reportId),
    onSuccess: onChange,
  });
  const router = useRouter();
  return (
    <Card>
      <View className="p-4 gap-3">
        <Text className="text-lg font-semibold text-foreground">
          {t('memberships.manage', 'Manage community')}
        </Text>
        <TextField>
          <TextFieldInput
            label={t('memberships.name', 'Community name')}
            value={name}
            onChangeText={setName}
            maxLength={120}
          />
        </TextField>
        <Textarea
          accessibilityLabel={t('memberships.description', 'Description')}
          value={description}
          onChangeText={setDescription}
          maxLength={5000}
          rows={4}
        />
        <Text className="text-muted-foreground">
          {t(
            'memberships.visibilityHelp',
            'Community name and description can be shared publicly, independently of your profile privacy. Posts and files are only available to authorized members.',
          )}
        </Text>
        <Button
          appearance="outline"
          onPress={() => setVisibility(visibility === 'public' ? 'unlisted' : 'public')}
        >
          {visibility === 'public'
            ? t('memberships.public', 'Public community')
            : t('memberships.unlisted', 'Unlisted community')}
        </Button>
        <Button
          disabled={!name.trim()}
          loading={mutation.isPending}
          onPress={() =>
            mutation.mutate({ name: name.trim(), description: description.trim(), visibility })
          }
        >
          {t('common.save', 'Save')}
        </Button>
        <View className="flex-row flex-wrap gap-2">
          {(['active', 'paused', 'closed'] as const)
            .filter((status) => status !== landing.community.status)
            .map((status) => (
              <Button
                key={status}
                appearance="outline"
                disabled={mutation.isPending}
                onPress={() => {
                  void (async () => {
                    if (
                      status === 'closed' &&
                      !(await confirmDestructive(
                        t('memberships.close', 'Close community?'),
                        t(
                          'memberships.closeHelp',
                          'Members will lose access until the community is activated again.',
                        ),
                        t('memberships.closeAction', 'Close'),
                        t('common.cancel', 'Cancel'),
                      ))
                    )
                      return;
                    mutation.mutate({ status });
                  })();
                }}
              >
                {status === 'active'
                  ? t('memberships.activate', 'Activate')
                  : status === 'paused'
                    ? t('memberships.pause', 'Pause joining')
                    : t('memberships.closeAction', 'Close')}
              </Button>
            ))}
        </View>
        <Text className="text-muted-foreground">
          {t(
            'memberships.freeOnly',
            'Free memberships are available. Paid subscriptions are not enabled.',
          )}
        </Text>
        {insights.isSuccess && !insights.isFetching
          ? insights.data.membershipsByState.map((row) => (
              <Text
                key={row.state}
                className="text-foreground"
              >{`${row.state}: ${row.total}`}</Text>
            ))
          : null}
        <Text className="font-semibold text-foreground">
          {t('memberships.tiers', 'Membership tiers')}
        </Text>
        {landing.tiers.map((tier) => (
          <MembershipTierEditor
            key={tier.id}
            communityId={landing.community.id}
            tier={tier}
            onChange={onChange}
          />
        ))}
        <MembershipTierEditor communityId={landing.community.id} onChange={onChange} />
        <Text className="font-semibold text-foreground">
          {t('memberships.reports', 'Content reports')}
        </Text>
        {reports.isError ? (
          <Text className="text-muted-foreground">
            {t('memberships.reportsUnavailable', 'Reports could not be loaded.')}
          </Text>
        ) : reports.isSuccess && !reports.isFetching ? (
          reports.data.map((report) => (
            <View key={report.id} className="gap-2">
              <Text className="text-foreground">{report.reason}</Text>
              <Button
                appearance="outline"
                onPress={() =>
                  router.push({
                    pathname: '/memberships/[id]',
                    params: { id: landing.community.id, thread: report.contentId },
                  })
                }
              >
                {t('memberships.reviewReport', 'Review reported content')}
              </Button>
              <Button
                appearance="outline"
                disabled={resolution.isPending}
                onPress={() => resolution.mutate(report.id)}
              >
                {t('memberships.resolveReport', 'Mark resolved')}
              </Button>
            </View>
          ))
        ) : null}
        {resolution.isError ? (
          <Text accessibilityRole="alert" className="text-destructive">
            {t('memberships.resolveFailed', 'The report could not be resolved.')}
          </Text>
        ) : null}
        {mutation.isError ? (
          <Text accessibilityRole="alert" className="text-destructive">
            {getErrorMessage(
              mutation.error,
              t('memberships.failed', 'The action could not be completed.'),
            )}
          </Text>
        ) : null}
      </View>
    </Card>
  );
}
