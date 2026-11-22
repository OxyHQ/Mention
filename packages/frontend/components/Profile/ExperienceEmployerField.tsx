import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { useDebouncedValue } from '@oxy.so/bloom/hooks';
import { organizationDirectoryQueryKeys } from '@/lib/viewerQueryKeys';
import { useState } from 'react';
import { Text } from 'react-native';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { nextUnvisitedCursor } from '@oxy.so/utils/paging';
import { parseOrganizationDraft } from '@oxy.so/services/organization-draft';
import { ORGANIZATION_NAME_MAX_LENGTH, ORGANIZATION_TYPES } from '@oxy.so/contracts/client';
import type {
  CreateOrganization,
  Organization,
  SafetyOrganizationIdentity,
  OrganizationType,
} from '@oxy.so/contracts';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { useTranslation } from 'react-i18next';
import { useSupervisionState } from '@/hooks/useSupervisionState';

import {
  Avatar as LAvatar,
  Button as LButton,
  Embed,
  HStack,
  RawText,
  Row,
  Text as LText,
  TextField as LTextField,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

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
  const [creating, setCreating] = useState(false);
  const [website, setWebsite] = useState('');
  const [country, setCountry] = useState('');
  const [organizationType, setOrganizationType] = useState<OrganizationType>('business');
  const [createInvalid, setCreateInvalid] = useState(false);
  const debounced = useDebouncedValue(query.trim(), 300);
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
    getNextPageParam: (page, _pages, _lastPageParam, pageParams) =>
      nextUnvisitedCursor(page.nextCursor, pageParams),
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
  return toElement(
    VStack(
      Embed(<TextFieldLabel>{label}</TextFieldLabel>),
      Embed(
        value ? (
          toElement(
            VStack(
              Row(employer?.name ?? t('profile.experience.unavailableEmployer'))
                .leadingView(
                  LAvatar(
                    !supervision.supervised &&
                      employer &&
                      'avatar' in employer &&
                      typeof employer.avatar === 'string'
                      ? employer.avatar
                      : undefined,
                    { name: employer?.name ?? t('profile.experience.unavailableEmployer') },
                  ).size('md'),
                )
                .subtitle(
                  !supervision.supervised &&
                    employer &&
                    'websiteUrl' in employer &&
                    typeof employer.websiteUrl === 'string'
                    ? (employer.websiteUrl ?? undefined)
                    : undefined,
                ),
              LButton(LText(t('profile.experience.changeEmployer')))
                .style('plain')
                .tint('neutral')
                .size('sm')
                .disabled(disabled)
                .onPress(() => {
                  onChange(null);
                  setSelected(undefined);
                  setQuery('');
                }),
            ).spacing('xs'),
          )
        ) : (
          <>
            {toElement(
              LTextField(
                [
                  query,
                  (text) => {
                    setQuery(text);
                    setCreating(false);
                    create.reset();
                  },
                ],
                label,
              )
                .maxLength(supervision.supervised ? 100 : ORGANIZATION_NAME_MAX_LENGTH)
                .invalid(invalid)
                .disabled(disabled || create.isPending),
            )}
            {toElement(
              RawText(t('profile.experience.companyHint'))
                .foreground('muted')
                .font('14')
                .leading('20px'),
            )}
            {debounced.length >= 2 && debounced === query.trim() && !creating
              ? toElement(
                  VStack(
                    Embed(
                      results.isPending ? (
                        <ListSkeleton count={2} />
                      ) : results.isError ? (
                        toElement(
                          VStack(
                            RawText(t('profile.experience.companySearchError'))
                              .foreground('muted')
                              .font('14')
                              .leading('20px'),
                            LButton(LText(t('common.retry', { defaultValue: 'Try again' })))
                              .style('plain')
                              .tint('neutral')
                              .size('sm')
                              .onPress(() => void results.refetch()),
                          ).spacing('sm'),
                        )
                      ) : (
                        <>
                          {results.data?.pages
                            .flatMap((page) => page.items)
                            .map((organization) =>
                              toElement(
                                Row(organization.name)
                                  .disabled(disabled)
                                  .leadingView(
                                    LAvatar(
                                      !supervision.supervised && 'avatar' in organization
                                        ? organization.avatar
                                        : undefined,
                                      { name: organization.name },
                                    ).size('md'),
                                  )
                                  .subtitle(
                                    !supervision.supervised && 'websiteUrl' in organization
                                      ? [organization.websiteUrl, organization.countryCode]
                                          .filter(Boolean)
                                          .join(' · ')
                                      : undefined,
                                  )
                                  .onPress(() => select(organization)),
                                organization.accountId,
                              ),
                            )}
                          {results.hasNextPage
                            ? toElement(
                                LButton(LText(t('common.loadMore', { defaultValue: 'Load more' })))
                                  .style('plain')
                                  .tint('neutral')
                                  .size('sm')
                                  .loading(results.isFetchingNextPage)
                                  .onPress(() => void results.fetchNextPage()),
                              )
                            : null}
                          {!supervision.supervised
                            ? toElement(
                                LButton(LText(t('profile.experience.addOrganization')))
                                  .style('plain')
                                  .tint('neutral')
                                  .size('sm')
                                  .disabled(!canUsePrivateApi || disabled)
                                  .onPress(() => setCreating(true)),
                              )
                            : null}
                        </>
                      ),
                    ),
                  ),
                )
              : null}
            {creating && !supervision.supervised
              ? toElement(
                  VStack(
                    RawText(query.trim()).foreground('foreground').weight('semibold'),
                    RawText(t('profile.experience.neutralOrganizationHint'))
                      .foreground('muted')
                      .font('14')
                      .leading('20px'),
                    Embed(
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
                      </Select>,
                    ),
                    Embed(
                      <TextFieldInput
                        label={t('profile.experience.website')}
                        value={website}
                        onChangeText={setWebsite}
                        autoCapitalize="none"
                        keyboardType="url"
                        editable={!create.isPending}
                      />,
                    ),
                    Embed(
                      <TextFieldInput
                        label={t('profile.experience.country')}
                        value={country}
                        onChangeText={setCountry}
                        maxLength={2}
                        autoCapitalize="characters"
                        editable={!create.isPending}
                      />,
                    ),
                    Embed(
                      createInvalid ? (
                        <Text accessibilityRole="alert" className="text-error-primary text-sm">
                          {t('profile.experience.organizationInvalid')}
                        </Text>
                      ) : null,
                    ),
                    Embed(
                      create.isError ? (
                        <Text accessibilityRole="alert" className="text-error-primary text-sm">
                          {t('profile.experience.organizationCreateError')}
                        </Text>
                      ) : null,
                    ),
                    HStack(
                      LButton(LText(t('common.cancel', { defaultValue: 'Cancel' })))
                        .style('plain')
                        .tint('neutral')
                        .size('sm')
                        .disabled(create.isPending)
                        .onPress(() => setCreating(false)),
                      LButton(LText(t('profile.experience.createOrganization')))
                        .size('sm')
                        .disabled(disabled || create.isPending || !canUsePrivateApi)
                        .loading(create.isPending)
                        .onPress(() => {
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
                        }),
                    )
                      .wrap()
                      .justify('end')
                      .spacing('sm'),
                  )
                    .padding('all', 'md')
                    .border('border', 'thin')
                    .corner('md')
                    .spacing('md'),
                )
              : null}
          </>
        ),
      ),
      Embed(
        invalid ? (
          <Text accessibilityRole="alert" className="text-error-primary text-sm">
            {t('profile.experience.validation.employerOxyAccountId')}
          </Text>
        ) : null,
      ),
    ).spacing('sm'),
  );
}
