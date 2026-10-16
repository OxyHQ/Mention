import { organizationDirectoryQueryKeys } from '@/lib/viewerQueryKeys';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import {
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_TYPES,
  createOrganizationSchema,
  type Organization,
  type OrganizationType,
} from '@oxy.so/contracts';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
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

/** Selection and neutral creation both address Oxy's one organization directory. */
export function ExperienceEmployerField({
  value,
  initialEmployer,
  disabled,
  invalid,
  onChange,
}: {
  value: string;
  initialEmployer?: Organization;
  disabled: boolean;
  invalid: boolean;
  onChange: (organization: Organization | null) => void;
}) {
  const { t } = useTranslation();
  const { user, isAuthenticated, canUsePrivateApi, oxyServices } = useAuth();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(initialEmployer);
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
    queryKey: organizationDirectoryQueryKeys.search(debounced, user?.id, isAuthenticated),
    queryFn: ({ pageParam }) =>
      oxyServices.organizations.search({
        query: debounced,
        limit: 20,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !value && debounced.length >= 2 && !disabled,
  });
  function select(organization: Organization) {
    setSelected(organization);
    setQuery(organization.name);
    setCreating(false);
    onChange(organization);
  }
  const create = useMutation({
    mutationFn: () => {
      if (!canUsePrivateApi || disabled) throw new Error('A personal session is required');
      return oxyServices.organizations.create(
        createOrganizationSchema.parse({
          name: query.trim(),
          organizationType,
          websiteUrl: website.trim() || null,
          countryCode: country.trim().toUpperCase() || null,
        }),
      );
    },
    onSuccess: (organization) => {
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
                source={employer?.avatar}
                name={employer?.name ?? t('profile.experience.unavailableEmployer')}
                size={32}
              />
            }
            title={employer?.name ?? t('profile.experience.unavailableEmployer')}
            subtitle={employer?.websiteUrl ?? undefined}
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
              maxLength={ORGANIZATION_NAME_MAX_LENGTH}
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
                <Loading size="sm" />
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
                          <Avatar source={organization.avatar} name={organization.name} size={32} />
                        }
                        title={organization.name}
                        subtitle={[organization.websiteUrl, organization.countryCode]
                          .filter(Boolean)
                          .join(' · ')}
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
                  <Button
                    appearance="plain"
                    tone="neutral"
                    size="sm"
                    disabled={!canUsePrivateApi || disabled}
                    onPress={() => setCreating(true)}
                  >
                    {t('profile.experience.addOrganization')}
                  </Button>
                </>
              )}
            </View>
          ) : null}
          {creating ? (
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
                    const result = createOrganizationSchema.safeParse({
                      name: query.trim(),
                      organizationType,
                      websiteUrl: website.trim() || null,
                      countryCode: country.trim().toUpperCase() || null,
                    });
                    setCreateInvalid(!result.success);
                    if (result.success) create.mutate();
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
