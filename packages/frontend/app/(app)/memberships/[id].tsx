import { MembershipDirectory } from '@/components/Memberships/MembershipDirectory';
import { MembershipTierEditor } from '@/components/Memberships/MembershipTierEditor';
import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { nextUnvisitedCursor } from '@oxy.so/utils/paging';
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

import {
  Button as LButton,
  Card as LCard,
  Embed,
  HStack,
  Header,
  RawText,
  ScrollView,
  Text as LText,
  TextEditor,
  TextField as LTextField,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

export default screen(function MembershipCommunityScreen() {
  const params = useLocalSearchParams<{ id: string; thread?: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const thread = typeof params.thread === 'string' ? params.thread : undefined;
  const { user, canUsePrivateApi } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const benefitLabels = {
    content_read: t('memberships.benefitRead', 'Read member content'),
    discussion_write: t('memberships.benefitDiscuss', 'Participate in discussions'),
    polls_vote: t('memberships.benefitVote', 'Vote in polls'),
    media_download: t('memberships.benefitDownload', 'Download private files'),
  };
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
    getNextPageParam: (page, _pages, _pageParam, pageParams) =>
      nextUnvisitedCursor(page.nextCursor, pageParams),
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
  const header = toElement(
    Header(landing.data?.community.name ?? t('memberships.title', 'Memberships'))
      .onBack(() => router.back())
      .toolbar(
        Embed(
          landing.data?.canManage
            ? toElement(
                LButton(LText(t('memberships.manage', 'Manage')))
                  .style('plain')
                  .onPress(() => setManage(!manage)),
              )
            : undefined,
        ),
      )
      .inPage(),
  );
  return ScrollView(
    Embed(
      landing.isPending || landing.isFetching ? (
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
          {toElement(
            LCard(
              VStack(
                RawText(landing.data.community.description).foreground('foreground'),
                RawText(
                  t(
                    'memberships.privateHelp',
                    'Only authorized members can read community posts and files.',
                  ),
                ).foreground('muted'),
                landing.data.tiers.some((tier) => tier.kind === 'free' && tier.status === 'active')
                  ? RawText(
                      t(
                        'memberships.freeOnly',
                        'Free memberships are available. Paid subscriptions are not enabled.',
                      ),
                    ).foreground('muted')
                  : null,
                Embed(
                  landing.data.tiers
                    .filter((tier) => tier.kind === 'free' && tier.status === 'active')
                    .map((tier) =>
                      toElement(
                        VStack(
                          RawText(tier.name)
                            .font('18')
                            .leading('28px')
                            .weight('semibold')
                            .foreground('foreground')
                            .role('header'),
                          tier.description ? RawText(tier.description).foreground('muted') : null,
                          Embed(
                            tier.benefits.map((benefit) =>
                              toElement(
                                RawText(benefitLabels[benefit]).foreground('foreground'),
                                benefit,
                              ),
                            ),
                          ),
                          canUsePrivateApi &&
                            !hasCurrentMembership(landing.data.membership) &&
                            !readable &&
                            landing.data.community.status === 'active'
                            ? LButton(LText(t('memberships.joinFree', 'Join free')))
                                .loading(mutation.isPending)
                                .disabled(landing.data.membership?.state === 'revoked')
                                .onPress(() =>
                                  mutation.mutate(() => membershipsService.join(id, tier.id)),
                                )
                            : null,
                        ).spacing('sm'),
                        tier.id,
                      ),
                    ),
                ),
                Embed(
                  !canUsePrivateApi ? (
                    <SignInRequired
                      label={t('memberships.signIn', 'Sign in to join a community')}
                      description={t(
                        'memberships.privateHelp',
                        'Only authorized members can read community posts and files.',
                      )}
                    />
                  ) : hasCurrentMembership(landing.data.membership) && landing.data.membership ? (
                    <>
                      {toElement(
                        LButton(
                          LText(
                            landing.data.membership.publicBadge
                              ? t('memberships.hideBadge', 'Hide my membership badge')
                              : t('memberships.showBadge', 'Show my membership publicly'),
                          ),
                        )
                          .style('outline')
                          .disabled(mutation.isPending)
                          .onPress(() =>
                            mutation.mutate(() =>
                              membershipsService.badge(id, !landing.data?.membership?.publicBadge),
                            ),
                          ),
                      )}
                      {toElement(
                        LButton(LText(t('memberships.leaveAction', 'Leave community')))
                          .style('plain')
                          .disabled(mutation.isPending)
                          .onPress(() => {
                            void leave();
                          }),
                      )}
                    </>
                  ) : null,
                ),
                landing.data.membership?.state === 'revoked'
                  ? RawText(
                      t('memberships.revoked', 'Your membership has been revoked.'),
                    ).foreground('muted')
                  : null,
              )
                .padding('all', 'lg')
                .spacing('md'),
            ),
          )}
          {mutation.isError
            ? toElement(
                RawText(
                  getErrorMessage(
                    mutation.error,
                    t('memberships.failed', 'The action could not be completed.'),
                  ),
                )
                  .foreground('destructive')
                  .role('alert'),
              )
            : null}
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
          {!readable && teaser.isSuccess && !teaser.isFetching && teaser.data.teaser
            ? toElement(
                LCard(
                  VStack(
                    RawText(t('memberships.publicTeaser', 'Public teaser')).foreground('muted'),
                    RawText(teaser.data.teaser).foreground('foreground'),
                  )
                    .padding('all', 'lg')
                    .spacing('sm'),
                ),
              )
            : null}
          {readable && user ? (
            <>
              {thread
                ? toElement(
                    LButton(LText(t('memberships.allPosts', 'All community posts')))
                      .style('plain')
                      .onPress(() => router.replace(`/memberships/${id}`)),
                  )
                : null}
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
              {contents.hasNextPage
                ? toElement(
                    LButton(LText(t('common.loadMore', 'Load more')))
                      .style('outline')
                      .loading(contents.isFetchingNextPage)
                      .onPress(() => {
                        void contents.fetchNextPage();
                      }),
                  )
                : null}
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
      ) : null,
    ),
  )
    .contentMargins('lg')
    .spacing('lg')
    .header(Embed(header));
});

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
  return toElement(
    LCard(
      VStack(
        RawText(t('memberships.manage', 'Manage community'))
          .font('18')
          .leading('28px')
          .weight('semibold')
          .foreground('foreground'),
        LTextField([name, setName], t('memberships.name', 'Community name')).maxLength(120),
        TextEditor([description, setDescription])
          .label(t('memberships.description', 'Description'))
          .maxLength(5000)
          .rows(4),
        RawText(
          t(
            'memberships.visibilityHelp',
            'Community name and description can be shared publicly, independently of your profile privacy. Posts and files are only available to authorized members.',
          ),
        ).foreground('muted'),
        LButton(
          LText(
            visibility === 'public'
              ? t('memberships.public', 'Public community')
              : t('memberships.unlisted', 'Unlisted community'),
          ),
        )
          .style('outline')
          .onPress(() => setVisibility(visibility === 'public' ? 'unlisted' : 'public')),
        LButton(LText(t('common.save', 'Save')))
          .disabled(!name.trim())
          .loading(mutation.isPending)
          .onPress(() =>
            mutation.mutate({ name: name.trim(), description: description.trim(), visibility }),
          ),
        HStack(
          Embed(
            (['active', 'paused', 'closed'] as const)
              .filter((status) => status !== landing.community.status)
              .map((status) =>
                toElement(
                  LButton(
                    LText(
                      status === 'active'
                        ? t('memberships.activate', 'Activate')
                        : status === 'paused'
                          ? t('memberships.pause', 'Pause joining')
                          : t('memberships.closeAction', 'Close'),
                    ),
                  )
                    .style('outline')
                    .disabled(mutation.isPending)
                    .onPress(() => {
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
                    }),
                  status,
                ),
              ),
          ),
        )
          .wrap()
          .spacing('sm'),
        RawText(
          t(
            'memberships.freeOnly',
            'Free memberships are available. Paid subscriptions are not enabled.',
          ),
        ).foreground('muted'),
        Embed(
          insights.isSuccess && !insights.isFetching
            ? insights.data.membershipsByState.map((row) =>
                toElement(
                  RawText(`${row.state}: ${row.total}`).foreground('foreground'),
                  row.state,
                ),
              )
            : null,
        ),
        RawText(t('memberships.tiers', 'Membership tiers'))
          .weight('semibold')
          .foreground('foreground'),
        Embed(
          landing.tiers.map((tier) => (
            <MembershipTierEditor
              key={tier.id}
              communityId={landing.community.id}
              tier={tier}
              onChange={onChange}
            />
          )),
        ),
        Embed(<MembershipTierEditor communityId={landing.community.id} onChange={onChange} />),
        RawText(t('memberships.reports', 'Content reports'))
          .weight('semibold')
          .foreground('foreground'),
        Embed(
          reports.isError
            ? toElement(
                RawText(
                  t('memberships.reportsUnavailable', 'Reports could not be loaded.'),
                ).foreground('muted'),
              )
            : reports.isSuccess && !reports.isFetching
              ? reports.data.map((report) =>
                  toElement(
                    VStack(
                      RawText(report.reason).foreground('foreground'),
                      LButton(LText(t('memberships.reviewReport', 'Review reported content')))
                        .style('outline')
                        .onPress(() =>
                          router.push({
                            pathname: '/memberships/[id]',
                            params: { id: landing.community.id, thread: report.contentId },
                          }),
                        ),
                      LButton(LText(t('memberships.resolveReport', 'Mark resolved')))
                        .style('outline')
                        .disabled(resolution.isPending)
                        .onPress(() => resolution.mutate(report.id)),
                    ).spacing('sm'),
                    report.id,
                  ),
                )
              : null,
        ),
        resolution.isError
          ? RawText(t('memberships.resolveFailed', 'The report could not be resolved.'))
              .foreground('destructive')
              .role('alert')
          : null,
        mutation.isError
          ? RawText(
              getErrorMessage(
                mutation.error,
                t('memberships.failed', 'The action could not be completed.'),
              ),
            )
              .foreground('destructive')
              .role('alert')
          : null,
      )
        .padding('all', 'lg')
        .spacing('md'),
    ),
  );
}
