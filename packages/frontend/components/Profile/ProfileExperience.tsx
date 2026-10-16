import { experienceService } from '@/services/experienceService';
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Link } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { useTranslation } from 'react-i18next';
import type { Experience } from '@clarity.surf/sdk/experience';
import { organizationDirectoryQueryKeys, viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useScreenReselect } from '@/context/ScreenReselectContext';
import type { Organization, SafetyOrganizationIdentity } from '@oxy.so/contracts';
import { useSupervisionState } from '@/hooks/useSupervisionState';
import { ExperienceEditor } from './ExperienceEditor';
import { experienceMonthLabel, experienceMonths, groupExperience } from './experiencePresentation';

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
    <Text>{name}</Text>
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
  useScreenReselect({
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
    return (
      <View key={entry.id} className="flex-row gap-4">
        {grouped ? (
          <View
            className="w-12 items-center"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <View className="h-2.5 w-2.5 rounded-full bg-muted-foreground mt-2" />
            {!last ? <View className="w-0.5 flex-1 bg-border mt-2 mb-1" /> : null}
          </View>
        ) : null}
        <View className="flex-1 pb-5">
          <View className="flex-row items-start gap-2">
            <Text className="flex-1 text-foreground text-lg font-semibold">{entry.title}</Text>
            {canEdit ? (
              <Button
                appearance="plain"
                tone="neutral"
                size="sm"
                accessibilityLabel={t('profile.experience.editRole', { title: entry.title })}
                onPress={() => setEditing(entry)}
              >
                {t('common.edit', { defaultValue: 'Edit' })}
              </Button>
            ) : null}
          </View>
          {!grouped || entry.employmentType ? (
            <Text className="text-foreground text-base mt-0.5">
              {!grouped ? (
                <CompanyName
                  showDetails={!supervision.supervised}
                  company={companyFor(entry.employerOxyAccountId)}
                  name={companyName(entry.employerOxyAccountId)}
                />
              ) : null}
              {!grouped && entry.employmentType ? ' · ' : ''}
              {entry.employmentType
                ? t(`profile.experience.employment.${entry.employmentType}`)
                : ''}
            </Text>
          ) : null}
          <Text className="text-muted-foreground text-base mt-1">{dates(entry)}</Text>
          {entry.location ? (
            <Text className="text-muted-foreground text-base mt-1">{entry.location}</Text>
          ) : null}
          {entry.description ? (
            <Text className="text-foreground text-base leading-6 mt-3">{entry.description}</Text>
          ) : null}
        </View>
      </View>
    );
  }

  if (!profileId) return null;

  return (
    <View className="px-4 pb-8">
      <View className="flex-row items-center justify-between gap-3 py-5">
        <Text accessibilityRole="header" className="text-foreground text-xl font-bold">
          {t('profile.tabs.experience')}
        </Text>
        {canEdit ? (
          <Button appearance="subtle" tone="neutral" size="sm" onPress={() => setEditing('new')}>
            {t('profile.experience.add')}
          </Button>
        ) : null}
      </View>
      {employers.isError ? (
        <View className="gap-2 pb-4">
          <Text className="text-muted-foreground text-sm">
            {t('profile.experience.employerLoadError')}
          </Text>
          <Button
            appearance="plain"
            tone="neutral"
            size="sm"
            onPress={() => void employers.refetch()}
          >
            {t('common.retry', { defaultValue: 'Try again' })}
          </Button>
        </View>
      ) : null}
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <View className="items-center gap-3 py-8">
          <Text className="text-muted-foreground text-center">
            {t('profile.experience.loadError')}
          </Text>
          <Button appearance="subtle" tone="neutral" onPress={() => void query.refetch()}>
            {t('common.retry', { defaultValue: 'Try again' })}
          </Button>
        </View>
      ) : !query.data?.length ? (
        <View className="py-10 gap-2">
          <Text className="text-foreground text-lg font-semibold text-center">
            {t('profile.experience.empty')}
          </Text>
          <Text className="text-muted-foreground text-center">
            {t(canEdit ? 'profile.experience.emptyOwner' : 'profile.experience.emptyVisitor')}
          </Text>
        </View>
      ) : (
        groupExperience(displayEntries).map((group, index, groups) => (
          <View
            key={group.key}
            className={index < groups.length - 1 ? 'border-b border-border mb-6' : ''}
          >
            <View className="flex-row gap-4">
              <CompanyLogo
                showDetails={!supervision.supervised}
                company={companyFor(group.employerOxyAccountId)}
                name={companyName(group.employerOxyAccountId)}
              />
              {group.entries.length === 1 ? (
                <View className="flex-1">{role(group.entries[0], false, true)}</View>
              ) : (
                <View className="flex-1 pb-5">
                  <Text className="text-foreground text-lg font-semibold">
                    {
                      <CompanyName
                        showDetails={!supervision.supervised}
                        company={companyFor(group.employerOxyAccountId)}
                        name={companyName(group.employerOxyAccountId)}
                      />
                    }
                  </Text>
                  <Text className="text-foreground text-base mt-1">
                    {duration(group.startDate, group.endDate)}
                  </Text>
                </View>
              )}
            </View>
            {group.entries.length > 1
              ? group.entries.map((entry, index) =>
                  role(entry, true, index === group.entries.length - 1),
                )
              : null}
          </View>
        ))
      )}
      {canEdit && editing ? (
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
      ) : null}
    </View>
  );
}
