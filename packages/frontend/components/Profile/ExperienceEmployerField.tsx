import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { organizationDirectoryQueryKeys } from '@/lib/viewerQueryKeys';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { parseOrganizationDraft } from '@oxy.so/services/organization-draft';
import { ORGANIZATION_NAME_MAX_LENGTH, ORGANIZATION_TYPES } from '@oxy.so/contracts/client';
import type {
  CreateOrganization,
  Organization,
  SafetyOrganizationIdentity,
  OrganizationType,
} from '@oxy.so/contracts';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { Item } from '@oxy.so/bloom/item';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { TextField, TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { useTranslation } from 'react-i18next';
import { useSupervisionState } from '@/hooks/useSupervisionState';

/** Selection and neutral creation both address Oxy's one organization directory. */
export function ExperienceEmployerField({
  value,
  initialEmployer,
  disabled,
  invalid,
  onChange,
}: {
  value: string;
  initialEmployer?: Organization | SafetyOrganizationIdentity;
  disabled: boolean;
  invalid: boolean;
  onChange: (organization: Organization | SafetyOrganizationIdentity | null) => void;
}) {
  const { t } = useTranslation();
  const { user, isAuthenticated, canUsePrivateApi, oxyServices } = useAuth();
  const [ownerSessionEpoch] = useState(() => oxyServices.http.getSessionEpoch());
  const queryClient = useQueryClient();
  const supervision = useSupervisionState();
  const [selected, setSelected] = useState<Organization | SafetyOrganizationIdentity | undefined>(
    initialEmployer,
  );
  const [query, setQuery] = useState(initialEmployer?.name ?? '');
  const [debounced, setDebounced] = useState(query);
  const [creating, setCreating] = useState(false);
  const [website, setWebsite] = useState('');
  const [country, setCountry] = useState('');
  const [organizationType, setOrganizationType] = useState<OrganizationType>('business');
  const [createInvalid, setCreateInvalid] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const results = useInfiniteQuery({
    queryKey: supervision.supervised
      ? organizationDirectoryQueryKeys.minimalSearch(debounced, user?.id, canUsePrivateApi)
      : organizationDirectoryQueryKeys.search(debounced, user?.id, isAuthenticated),
    queryFn: async ({
      pageParam,
    }): Promise<{
      items: (Organization | SafetyOrganizationIdentity)[];
      nextCursor: string | null;
    }> => {
      if (supervision.supervised) {
        const result = await oxyServices.safety.organizations({ query: debounced, limit: 20 });
        return { items: result.items.map((item) => item.organization), nextCursor: null };
      }
      return oxyServices.organizations.search({
        query: debounced,
        limit: 20,
        ...(pageParam ? { cursor: pageParam } : {}),
      });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled:
      !value &&
      debounced.length >= 2 &&
      !disabled &&
      supervision.ready &&
      (!supervision.supervised || canUsePrivateApi),
    gcTime: 0,
  });
  function select(organization: Organization | SafetyOrganizationIdentity) {
    setSelected(organization);
    setQuery(organization.name);
    setCreating(false);
    onChange(organization);
  }
  const create = useMutation({
    mutationFn: (organization: CreateOrganization) => {
      if (
        !canUsePrivateApi ||
        disabled ||
        !supervision.ready ||
        supervision.supervised ||
        oxyServices.http.getSessionEpoch() !== ownerSessionEpoch
      )
        throw new Error('A personal session is required');
      return oxyServices.organizations.create(organization);
    },
    onSuccess: (organization) => {
      if (oxyServices.http.getSessionEpoch() !== ownerSessionEpoch) return;
      select(organization);
      void queryClient.invalidateQueries({ queryKey: organizationDirectoryQueryKeys.all() });
    },
  });
  const employer = selected ?? initialEmployer;
  const label = t('profile.experience.fields.employerOxyAccountId');
  const options = ORGANIZATION_TYPES.map((value) => ({
    value,
    label: t(`profile.experience.organizationTypes.${value}`),
  }));
  return (
    <View className="gap-2">
      <TextFieldLabel>{label}</TextFieldLabel>
      {value ? (
        <View className="gap-1">
          <Item
            leading={
              <Avatar
                source={
                  !supervision.supervised &&
                  employer &&
                  'avatar' in employer &&
                  typeof employer.avatar === 'string'
                    ? employer.avatar
                    : undefined
                }
                name={employer?.name ?? t('profile.experience.unavailableEmployer')}
                size={32}
              />
            }
            title={employer?.name ?? t('profile.experience.unavailableEmployer')}
            subtitle={
              !supervision.supervised &&
              employer &&
              'websiteUrl' in employer &&
              typeof employer.websiteUrl === 'string'
                ? (employer.websiteUrl ?? undefined)
                : undefined
            }
          />
          <Button
            appearance="plain"
            tone="neutral"
            size="sm"
            disabled={disabled}
            onPress={() => {
              onChange(null);
              setSelected(undefined);
              setQuery('');
            }}
          >
            {t('profile.experience.changeEmployer')}
          </Button>
        </View>
      ) : (
        <>
          <TextField invalid={invalid} disabled={disabled || create.isPending}>
            <TextFieldInput
              label={label}
              value={query}
              maxLength={supervision.supervised ? 100 : ORGANIZATION_NAME_MAX_LENGTH}
              onChangeText={(text) => {
                setQuery(text);
                setCreating(false);
                create.reset();
              }}
            />
          </TextField>
          <Text className="text-muted-foreground text-sm">
            {t('profile.experience.companyHint')}
          </Text>
          {debounced.length >= 2 && debounced === query.trim() && !creating ? (
            <View>
              {results.isPending ? (
                <ListSkeleton count={2} />
              ) : results.isError ? (
                <View className="gap-2">
                  <Text className="text-muted-foreground text-sm">
                    {t('profile.experience.companySearchError')}
                  </Text>
                  <Button
                    appearance="plain"
                    tone="neutral"
                    size="sm"
                    onPress={() => void results.refetch()}
                  >
                    {t('common.retry', { defaultValue: 'Try again' })}
                  </Button>
                </View>
              ) : (
                <>
                  {results.data?.pages
                    .flatMap((page) => page.items)
                    .map((organization) => (
                      <Item
                        key={organization.accountId}
                        disabled={disabled}
                        leading={
                          <Avatar
                            source={
                              !supervision.supervised && 'avatar' in organization
                                ? organization.avatar
                                : undefined
                            }
                            name={organization.name}
                            size={32}
                          />
                        }
                        title={organization.name}
                        subtitle={
                          !supervision.supervised && 'websiteUrl' in organization
                            ? [organization.websiteUrl, organization.countryCode]
                                .filter(Boolean)
                                .join(' · ')
                            : undefined
                        }
                        onPress={() => select(organization)}
                      />
                    ))}
                  {results.hasNextPage ? (
                    <Button
                      appearance="plain"
                      tone="neutral"
                      size="sm"
                      loading={results.isFetchingNextPage}
                      onPress={() => void results.fetchNextPage()}
                    >
                      {t('common.loadMore', { defaultValue: 'Load more' })}
                    </Button>
                  ) : null}
                  {!supervision.supervised ? (
                    <Button
                      appearance="plain"
                      tone="neutral"
                      size="sm"
                      disabled={!canUsePrivateApi || disabled}
                      onPress={() => setCreating(true)}
                    >
                      {t('profile.experience.addOrganization')}
                    </Button>
                  ) : null}
                </>
              )}
            </View>
          ) : null}
          {creating && !supervision.supervised ? (
            <View className="gap-3 rounded-xl border border-border p-3">
              <Text className="text-foreground font-semibold">{query.trim()}</Text>
              <Text className="text-muted-foreground text-sm">
                {t('profile.experience.neutralOrganizationHint')}
              </Text>
              <Select
                value={organizationType}
                disabled={create.isPending}
                onValueChange={(value) => {
                  const type = ORGANIZATION_TYPES.find((candidate) => candidate === value);
                  if (type) setOrganizationType(type);
                }}
              >
                <SelectTrigger label={t('profile.experience.organizationType')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  items={options}
                  renderItem={(option) => (
                    <SelectItem value={option.value} label={option.label}>
                      <SelectItemText>{option.label}</SelectItemText>
                    </SelectItem>
                  )}
                />
              </Select>
              <TextFieldInput
                label={t('profile.experience.website')}
                value={website}
                onChangeText={setWebsite}
                autoCapitalize="none"
                keyboardType="url"
                editable={!create.isPending}
              />
              <TextFieldInput
                label={t('profile.experience.country')}
                value={country}
                onChangeText={setCountry}
                maxLength={2}
                autoCapitalize="characters"
                editable={!create.isPending}
              />
              {createInvalid ? (
                <Text accessibilityRole="alert" className="text-error-primary text-sm">
                  {t('profile.experience.organizationInvalid')}
                </Text>
              ) : null}
              {create.isError ? (
                <Text accessibilityRole="alert" className="text-error-primary text-sm">
                  {t('profile.experience.organizationCreateError')}
                </Text>
              ) : null}
              <View className="flex-row flex-wrap justify-end gap-2">
                <Button
                  appearance="plain"
                  tone="neutral"
                  size="sm"
                  disabled={create.isPending}
                  onPress={() => setCreating(false)}
                >
                  {t('common.cancel', { defaultValue: 'Cancel' })}
                </Button>
                <Button
                  size="sm"
                  disabled={disabled || create.isPending || !canUsePrivateApi}
                  loading={create.isPending}
                  onPress={() => {
                    // The client twin of the contract's schema: the same verdict,
                    // without loading Zod into the app.
                    const organization = parseOrganizationDraft({
                      name: query,
                      organizationType,
                      websiteUrl: website,
                      countryCode: country,
                    });
                    setCreateInvalid(organization === null);
                    if (organization) create.mutate(organization);
                  }}
                >
                  {t('profile.experience.createOrganization')}
                </Button>
              </View>
            </View>
          ) : null}
        </>
      )}
      {invalid ? (
        <Text accessibilityRole="alert" className="text-error-primary text-sm">
          {t('profile.experience.validation.employerOxyAccountId')}
        </Text>
      ) : null}
    </View>
  );
}
