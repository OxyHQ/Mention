import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { experienceService } from '@/services/experienceService';
import { useState } from 'react';
import { Link } from '@/lib/navigation/router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { Avatar } from '@oxy.so/bloom/avatar';
import { useTranslation } from 'react-i18next';
import type { Experience } from '@clarity.surf/sdk/experience';
import { organizationDirectoryQueryKeys, viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useScreenReselectHandler } from '@oxy.so/bloom/screen';
import type { Organization, SafetyOrganizationIdentity } from '@oxy.so/contracts';
import { useSupervisionState } from '@/hooks/useSupervisionState';
import { ExperienceEditor } from './ExperienceEditor';
import { experienceMonthLabel, experienceMonths, groupExperience } from './experiencePresentation';
import {
  Button as LButton,
  Embed,
  HStack,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

function CompanyLogo({
  company,
  name,
  showDetails,
}: {
  company?: Organization | SafetyOrganizationIdentity;
  name: string;
  showDetails: boolean;
}) {
  const avatar = (
    <Avatar
      source={showDetails && company && 'avatar' in company ? company.avatar : undefined}
      name={name}
      size={48}
      shape="squircle"
    />
  );
  return showDetails && company?.username ? (
    <Link href={`/@${company.username}`} accessibilityLabel={name}>
      {avatar}
    </Link>
  ) : (
    avatar
  );
}

function CompanyName({
  company,
  name,
  showDetails,
}: {
  company?: Organization | SafetyOrganizationIdentity;
  name: string;
  showDetails: boolean;
}) {
  return showDetails && company?.username ? (
    <Link href={`/@${company.username}`}>{name}</Link>
  ) : (
    toElement(RawText(name))
  );
}

export function ProfileExperience({
  profileId,
  isOwnProfile,
}: {
  profileId?: string;
  isOwnProfile: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { user, isAuthenticated, canUsePrivateApi, oxyServices } = useAuth();
  const queryClient = useQueryClient();
  const supervision = useSupervisionState();
  const [editing, setEditing] = useState<Experience | 'new' | null>(null);
  const canEdit = isOwnProfile && Boolean(profileId && user?.id === profileId) && canUsePrivateApi;
  const queryKey = viewerQueryKeys.profileExperience(
    user?.id,
    profileId ?? '',
    isAuthenticated,
    canUsePrivateApi,
  );
  const query = useQuery({
    queryKey,
    queryFn: () => experienceService.list(profileId as string, canUsePrivateApi),
    enabled: Boolean(profileId) && (!isAuthenticated || canUsePrivateApi),
    retry: false,
    gcTime: 0,
  });
  const employerIds = [
    ...new Set((query.data ?? []).map((entry) => entry.employerOxyAccountId)),
  ].sort();
  const employers = useQuery({
    queryKey: supervision.supervised
      ? organizationDirectoryQueryKeys.minimalBatch(employerIds, user?.id, canUsePrivateApi)
      : organizationDirectoryQueryKeys.batch(employerIds, user?.id, isAuthenticated),
    queryFn: () =>
      supervision.supervised
        ? oxyServices.safety.organizations({ ids: employerIds })
        : oxyServices.organizations.batch({ ids: employerIds }),
    enabled:
      employerIds.length > 0 && supervision.ready && (!supervision.supervised || canUsePrivateApi),
    gcTime: 0,
  });
  const companies = new Map(
    (employers.data?.items ?? []).map(({ requestedAccountId, organization }) => [
      requestedAccountId,
      organization,
    ]),
  );
  const companyFor = (id: string) => companies.get(id);
  const companyName = (id: string) =>
    companyFor(id)?.name ??
    t(
      employers.isPending && employerIds.length
        ? 'profile.experience.loadingEmployer'
        : 'profile.experience.unavailableEmployer',
    );
  // Two historical IDs can resolve to the same organization after a verified merge.
  const displayEntries = (query.data ?? []).map((entry) => ({
    ...entry,
    employerOxyAccountId:
      companyFor(entry.employerOxyAccountId)?.accountId ?? entry.employerOxyAccountId,
  }));
  for (const { organization } of employers.data?.items ?? [])
    companies.set(organization.accountId, organization);
  useScreenReselectHandler({
    refresh: async () => {
      await Promise.all([query.refetch(), ...(employerIds.length ? [employers.refetch()] : [])]);
    },
  });

  function duration(start: string, end: string | null): string {
    const total = experienceMonths(start, end);
    const years = Math.floor(total / 12);
    const months = total % 12;
    return [
      years ? t('profile.experience.years', { count: years }) : '',
      months ? t('profile.experience.months', { count: months }) : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  function dates(entry: Experience): string {
    return `${experienceMonthLabel(entry.startDate, i18n.language)} – ${entry.endDate ? experienceMonthLabel(entry.endDate, i18n.language) : t('profile.experience.present')} · ${duration(entry.startDate, entry.endDate)}`;
  }
  function role(entry: Experience, grouped: boolean, last: boolean) {
    return toElement(
      HStack(
        // The rail is hidden from assistive technology.
        grouped
          ? VStack(
              VStack()
                .frame({ height: '10', width: '10' })
                .background('muted')
                .corner('infinite')
                .margin('top', 'sm'),
              !last
                ? VStack()
                    .frame({ width: '2xs' })
                    .background('border')
                    .flex('1')
                    .margin('top', 'sm')
                    .margin('bottom', 'xs')
                : null,
            )
              .frame({ width: '48' })
              .align('center')
              .accessibilityHidden()
          : null,
        VStack(
          HStack(
            RawText(entry.title)
              .flex('1')
              .foreground('foreground')
              .font('18')
              .leading('28px')
              .weight('semibold'),
            canEdit
              ? LButton(LText(t('common.edit', { defaultValue: 'Edit' })))
                  .style('plain')
                  .tint('neutral')
                  .size('sm')
                  .label(t('profile.experience.editRole', { title: entry.title }))
                  .onPress(() => setEditing(entry))
              : null,
          )
            .align('start')
            .spacing('sm'),
          // A company's name may be a router Link: it is a run of the line as it is.
          !grouped || entry.employmentType
            ? RawText(
                !grouped
                  ? Embed(
                      <CompanyName
                        showDetails={!supervision.supervised}
                        company={companyFor(entry.employerOxyAccountId)}
                        name={companyName(entry.employerOxyAccountId)}
                      />,
                    )
                  : null,
                !grouped && entry.employmentType ? ' · ' : '',
                entry.employmentType
                  ? t(`profile.experience.employment.${entry.employmentType}`)
                  : '',
              )
                .foreground('foreground')
                .font('16')
                .leading('24px')
                .margin('top', '2xs')
            : null,
          RawText(dates(entry))
            .foreground('muted')
            .font('16')
            .leading('normal')
            .margin('top', 'xs'),
          entry.location
            ? RawText(entry.location)
                .foreground('muted')
                .font('16')
                .leading('normal')
                .margin('top', 'xs')
            : null,
          entry.description
            ? RawText(entry.description)
                .foreground('foreground')
                .font('16')
                .leading('24px')
                .margin('top', 'md')
            : null,
        )
          .padding('bottom', 'xl')
          .flex('1'),
      ).spacing('lg'),
      entry.id,
    );
  }

  if (!profileId) return null;

  return toElement(
    VStack(
      HStack(
        RawText(t('profile.tabs.experience'))
          .foreground('foreground')
          .font('xl')
          .leading('28px')
          .weight('bold')
          .role('header'),
        canEdit
          ? LButton(LText(t('profile.experience.add')))
              .style('subtle')
              .tint('neutral')
              .size('sm')
              .onPress(() => setEditing('new'))
          : null,
      )
        .padding('vertical', 'xl')
        .align('center')
        .justify('between')
        .spacing('md'),
      employers.isError
        ? VStack(
            RawText(t('profile.experience.employerLoadError'))
              .foreground('muted')
              .font('14')
              .leading('20px'),
            LButton(LText(t('common.retry', { defaultValue: 'Try again' })))
              .style('plain')
              .tint('neutral')
              .size('sm')
              .onPress(() => void employers.refetch()),
          )
            .padding('bottom', 'lg')
            .spacing('sm')
        : null,
      Embed(
        query.isPending ? (
          <ListSkeleton />
        ) : query.isError ? (
          toElement(
            VStack(
              RawText(t('profile.experience.loadError')).foreground('muted').textAlign('center'),
              LButton(LText(t('common.retry', { defaultValue: 'Try again' })))
                .style('subtle')
                .tint('neutral')
                .onPress(() => void query.refetch()),
            )
              .padding('vertical', '3xl')
              .align('center')
              .spacing('md'),
          )
        ) : !query.data?.length ? (
          toElement(
            VStack(
              RawText(t('profile.experience.empty'))
                .foreground('foreground')
                .font('18')
                .leading('28px')
                .weight('semibold')
                .textAlign('center'),
              RawText(
                t(canEdit ? 'profile.experience.emptyOwner' : 'profile.experience.emptyVisitor'),
              )
                .foreground('muted')
                .textAlign('center'),
            )
              .padding('vertical', '4xl')
              .spacing('sm'),
          )
        ) : (
          groupExperience(displayEntries).map((group, index, groups) =>
            toElement(
              VStack(
                HStack(
                  Embed(
                    <CompanyLogo
                      showDetails={!supervision.supervised}
                      company={companyFor(group.employerOxyAccountId)}
                      name={companyName(group.employerOxyAccountId)}
                    />,
                  ),
                  group.entries.length === 1
                    ? VStack(Embed(role(group.entries[0], false, true))).flex('1')
                    : VStack(
                        RawText(
                          Embed(
                            <CompanyName
                              showDetails={!supervision.supervised}
                              company={companyFor(group.employerOxyAccountId)}
                              name={companyName(group.employerOxyAccountId)}
                            />,
                          ),
                        )
                          .foreground('foreground')
                          .font('18')
                          .leading('28px')
                          .weight('semibold'),
                        RawText(duration(group.startDate, group.endDate))
                          .foreground('foreground')
                          .font('16')
                          .leading('normal')
                          .margin('top', 'xs'),
                      )
                        .padding('bottom', 'xl')
                        .flex('1'),
                ).spacing('lg'),
                Embed(
                  group.entries.length > 1
                    ? group.entries.map((entry, index) =>
                        role(entry, true, index === group.entries.length - 1),
                      )
                    : null,
                ),
              ).when(index < groups.length - 1, (v) =>
                v.border('border', 'thin', 'bottom').margin('bottom', '2xl'),
              ),
              group.key,
            ),
          )
        ),
      ),
      Embed(
        canEdit && editing ? (
          <ExperienceEditor
            key={editing === 'new' ? 'new' : editing.id}
            entry={editing === 'new' ? undefined : editing}
            ownerId={profileId as string}
            employer={editing === 'new' ? undefined : companyFor(editing.employerOxyAccountId)}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              void queryClient.invalidateQueries({ queryKey });
            }}
          />
        ) : null,
      ),
    )
      .padding('horizontal', 'lg')
      .padding('bottom', '3xl'),
  );
}
