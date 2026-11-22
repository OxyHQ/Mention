import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { ProfileCard } from '@/components/ProfileCard';
import { membershipsService } from '@/services/membershipsService';
import { membershipKeys, membershipQueryPolicy } from './membershipQueries';
import { Embed, RawText, VStack, toElement } from '@oxy.so/bloom-language';

/** Only identities that explicitly opted into the public directory reach Oxy's bulk lookup. */
export function MembershipDirectory({ communityId }: { communityId: string }) {
  const { user, oxyServices } = useAuth();
  const { t } = useTranslation();
  const directory = useQuery({
    ...membershipQueryPolicy,
    queryKey: membershipKeys.directory(user?.id, communityId),
    queryFn: async ({ signal }) => {
      const members = await membershipsService.directory(communityId, signal);
      if (signal.aborted) throw new Error('Cancelled directory request');
      return members.length
        ? oxyServices.users.getMany(members.map((member) => member.oxyUserId))
        : [];
    },
  });
  return toElement(
    VStack(
      RawText(t('memberships.directory', 'Public member directory'))
        .weight('semibold')
        .foreground('foreground'),
      RawText(
        t(
          'memberships.directoryHelp',
          'Only members who choose to show their membership appear here.',
        ),
      ).foreground('muted'),
      Embed(
        directory.isSuccess && !directory.isFetching
          ? directory.data.map((member) => (
              <ProfileCard
                key={member.id}
                profile={member}
                showFollowButton={false}
                accessory={toElement(
                  RawText(t('memberships.memberBadge', 'Member')).foreground('muted'),
                )}
              />
            ))
          : null,
      ),
    ).spacing('sm'),
  );
}
