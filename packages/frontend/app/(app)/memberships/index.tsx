import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { useIsFocused, useRouter } from '@/lib/navigation/router';
import { SignInRequired } from '@/components/common/SignInRequired';
import { EmptyState } from '@/components/common/EmptyState';
import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { membershipsService } from '@/services/membershipsService';
import { membershipKeys, membershipQueryPolicy } from '@/components/Memberships/membershipQueries';

import {
  Button as LButton,
  Embed,
  Header,
  RawText,
  ScrollView,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { Card as LCard } from '@oxy.so/bloom-language/containers';
import { screen } from '@oxy.so/bloom-language/router';

export default screen(function MembershipsScreen() {
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
  const header = toElement(
    Header(t('memberships.title', 'Memberships'))
      .onBack(() => router.back())
      .toolbar(
        Embed(
          canUsePrivateApi
            ? toElement(
                LButton(LText(t('memberships.create', 'Create community'))).onPress(() =>
                  router.push('/memberships/create'),
                ),
              )
            : undefined,
        ),
      )
      .inPage(),
  );
  if (!canUsePrivateApi)
    return Embed(
      <SignInRequired
        label={t('memberships.signIn', 'Sign in to join a community')}
        description={t(
          'memberships.privateHelp',
          'Only authorized members can read community posts and files.',
        )}
      />,
    ).header(Embed(header));
  return ScrollView(
    Embed(
      query.isPending || query.isFetching ? (
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
          ).map(([key, label]) =>
            toElement(
              VStack(
                RawText(label)
                  .font('18')
                  .leading('28px')
                  .weight('semibold')
                  .foreground('foreground'),
                Embed(
                  query.data[key].length
                    ? query.data[key].map((community) =>
                        toElement(
                          LCard(
                            VStack(
                              RawText(community.name)
                                .font('18')
                                .leading('28px')
                                .weight('semibold')
                                .foreground('foreground'),
                              RawText(community.description).foreground('muted'),
                              LButton(LText(t('memberships.open', 'Open community')))
                                .style('outline')
                                .onPress(() => router.push(`/memberships/${community.id}`)),
                            )
                              .padding('all', 'lg')
                              .spacing('sm'),
                          ),
                          community.id,
                        ),
                      )
                    : toElement(
                        RawText(t('memberships.empty', 'No communities yet.')).foreground('muted'),
                      ),
                ),
              ).spacing('md'),
              key,
            ),
          )}
        </>
      ) : null,
    ),
  )
    .contentMargins('lg')
    .spacing('lg')
    .header(Embed(header));
});
