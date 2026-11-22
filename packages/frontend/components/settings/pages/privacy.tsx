import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import { SupervisedFeatureGate } from '@/components/SupervisedFeatureGate';
import type { BloomIcon } from '@/components/settings/RowIcon';
import { useSettingsRouter } from '@/context/MentionSettingsContext';
import { queryClient } from '@/lib/queryClient';
import {
  DEFAULT_RECOMMENDATION_FILTERS,
  getRecommendationFilters,
  saveRecommendationFilters,
  type RecommendationFilters,
} from '@/lib/recommendationFilters';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useViewerSettingsSection } from '@/hooks/useViewerSettings';
import { invalidateSafetyFilters } from '@/stores/safetyInvalidation';
import { RiEarthLine } from '@oxy.so/bloom/icons/RiEarthLine';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { logger } from '@oxy.so/core/logger';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button as LButton,
  Embed,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  SettingsSection as LSettingsSection,
  Text,
  Toggle,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

const FILTER_TOGGLES: {
  icon: BloomIcon;
  titleKey: string;
  descKey: string;
  titleDefault: string;
  descDefault: string;
  filterKey: keyof RecommendationFilters;
}[] = [
  {
    icon: RiEarthLine,
    titleKey: 'settings.privacy.showFediverse',
    descKey: 'settings.privacy.showFediverseDesc',
    titleDefault: 'Fediverse accounts in suggestions',
    descDefault: 'Show accounts from Mastodon and other fediverse instances',
    filterKey: 'showFederated',
  },
  {
    icon: RiSparklingLine,
    titleKey: 'settings.privacy.showAgents',
    descKey: 'settings.privacy.showAgentsDesc',
    titleDefault: 'AI agents in suggestions',
    descDefault: 'Show AI-powered bot accounts',
    filterKey: 'showAgents',
  },
  {
    icon: RiRefreshLine,
    titleKey: 'settings.privacy.showAutomated',
    descKey: 'settings.privacy.showAutomatedDesc',
    titleDefault: 'Automated accounts in suggestions',
    descDefault: 'Show scheduled and feed-based accounts',
    filterKey: 'showAutomated',
  },
];

function PrivacySettingsScreen() {
  const router = useSettingsRouter();
  const { t } = useTranslation();

  const { isAuthenticated, isAuthResolved, canUsePrivateApi, isPrivateApiPending, user } =
    useAuth();
  const viewerId = user?.id;

  const {
    value: privacySettings,
    isLoading: loading,
    update: updatePrivacy,
  } = useViewerSettingsSection('privacy');
  const [recFilters, setRecFilters] = useState<RecommendationFilters>(
    DEFAULT_RECOMMENDATION_FILTERS,
  );

  useEffect(() => {
    if (!isAuthResolved || isPrivateApiPending || !isAuthenticated || !viewerId) return;
    getRecommendationFilters(viewerId).then(setRecFilters);
  }, [isAuthResolved, isPrivateApiPending, isAuthenticated, viewerId]);

  const updateRecFilter = (key: keyof RecommendationFilters, value: boolean) => {
    const updated = { ...recFilters, [key]: value };
    setRecFilters(updated);
    void saveRecommendationFilters(updated, viewerId);
    // Prime the shared filters query so `useRecommendations` re-derives its
    // `excludeTypes` cache key and refetches every recommendation surface
    // (explore tab, widget, suggestions) reactively — no manual invalidation.
    if (viewerId) {
      queryClient.setQueryData(viewerQueryKeys.recommendationFilters(viewerId), updated);
    }
  };

  const updatePrivacyToggle = async (
    field: 'showSensitiveContent' | 'searchEngineIndexing' | 'showLikes',
    value: boolean,
  ) => {
    try {
      await updatePrivacy({ [field]: value });
      // Sensitive content is excluded by the SERVER's feed/search queries,
      // so a cache filled under the previous answer is now showing (or
      // withholding) exactly what the viewer just decided about. One
      // authority tells both read caches: `stores/safetyInvalidation`.
      if (field === 'showSensitiveContent') invalidateSafetyFilters();
    } catch (error) {
      logger.error('Error updating privacy setting', error, { field });
    }
  };

  const getProfileVisibilityText = () => {
    const visibility = privacySettings.profileVisibility || 'public';
    if (visibility === 'private') return t('settings.privacy.private');
    if (visibility === 'followers_only') return t('settings.privacy.followersOnly');
    return t('settings.privacy.public');
  };

  if (!isAuthResolved || isPrivateApiPending) {
    return toElement(VStack(Embed(<SettingsSkeleton />)).spacing('lg'));
  }

  if (!canUsePrivateApi) {
    return toElement(
      VStack(
        Embed(
          <OxyAuthPrompt
            label={t('settings.privacy.signInRequired', {
              defaultValue: 'Sign in to manage your privacy settings',
            })}
            description={t('settings.privacy.signInRequiredDesc', {
              defaultValue: 'Control who can see your profile, mention you, and more.',
            })}
          />,
        ),
      ).spacing('lg'),
    );
  }

  if (loading) {
    return toElement(VStack(Embed(<SettingsSkeleton />)).spacing('lg'));
  }

  return toElement(
    VStack(
      VStack(
        LSettingsSection(
          undefined,
          LGroupedSection(
            LGroupedSectionItem(t('settings.privacy.privateProfile'))
              .wrapControl()
              .description(
                t('settings.privacy.privateProfileDesc', {
                  defaultValue: 'Control who can see your profile',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LButton(Text(getProfileVisibilityText()))
                        .size('sm')
                        .style('subtle')
                        .tint('neutral')
                        .onPress(() => router.push('/settings/privacy/profile-visibility'))
                        .label(t('settings.privacy.privateProfile')),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(t('settings.privacy.searchEngines'))
              .wrapControl()
              .description(t('settings.privacy.searchEnginesDesc'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([
                        privacySettings.searchEngineIndexing ?? true,
                        (value) => updatePrivacyToggle('searchEngineIndexing', value),
                      ]).label(t('settings.privacy.searchEngines')),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(t('settings.privacy.showLikes'))
              .wrapControl()
              .description(t('settings.privacy.showLikesDesc'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([
                        privacySettings.showLikes ?? false,
                        (value) => updatePrivacyToggle('showLikes', value),
                      ]).label(t('settings.privacy.showLikes')),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(t('settings.privacy.tagsAndMentions'))
              .wrapControl()
              .description(
                t('settings.privacy.tagsAndMentionsDesc', {
                  defaultValue: 'Choose who can tag or mention you',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LButton(Text(t('common.open', { defaultValue: 'Open' })))
                        .size('sm')
                        .style('subtle')
                        .tint('neutral')
                        .onPress(() => router.push('/settings/privacy/tags-mentions'))
                        .label(t('settings.privacy.tagsAndMentions')),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(t('settings.privacy.onlineStatus.title'))
              .wrapControl()
              .description(
                t('settings.privacy.onlineStatusDesc', {
                  defaultValue: 'Show when you are active',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LButton(Text(t('common.open', { defaultValue: 'Open' })))
                        .size('sm')
                        .style('subtle')
                        .tint('neutral')
                        .onPress(() => router.push('/settings/privacy/online-status'))
                        .label(t('settings.privacy.onlineStatus.title')),
                    )}
                  </>,
                ),
              ),
          ),
        ),
        LSettingsSection(
          undefined,
          LGroupedSection(
            LGroupedSectionItem(t('settings.privacy.restrictedProfiles'))
              .wrapControl()
              .description(
                t('settings.privacy.restrictedProfilesDesc', {
                  defaultValue: 'Limit interactions from specific people',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LButton(Text(t('common.open', { defaultValue: 'Open' })))
                        .size('sm')
                        .style('subtle')
                        .tint('neutral')
                        .onPress(() => router.push('/settings/privacy/restricted'))
                        .label(t('settings.privacy.restrictedProfiles')),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(t('settings.privacy.blockedProfiles'))
              .wrapControl()
              .description(
                t('settings.privacy.blockedProfilesDesc', {
                  defaultValue: 'People you have blocked',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LButton(Text(t('common.open', { defaultValue: 'Open' })))
                        .size('sm')
                        .style('subtle')
                        .tint('neutral')
                        .onPress(() => router.push('/settings/privacy/blocked'))
                        .label(t('settings.privacy.blockedProfiles')),
                    )}
                  </>,
                ),
              ),
          ),
        ),
        LSettingsSection(
          undefined,
          LGroupedSection(
            LGroupedSectionItem(t('settings.privacy.hiddenWords'))
              .wrapControl()
              .description(
                t('settings.privacy.hiddenWordsDesc', {
                  defaultValue: 'Filter posts containing specific words',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LButton(Text(t('common.open', { defaultValue: 'Open' })))
                        .size('sm')
                        .style('subtle')
                        .tint('neutral')
                        .onPress(() => router.push('/settings/privacy/hidden-words'))
                        .label(t('settings.privacy.hiddenWords')),
                    )}
                  </>,
                ),
              ),
            /* Beside muted words because a reader looking for "stop
                          showing me this" looks in one place — but a separate
                          screen, because the two are different rules: a muted word
                          is a safety filter that reaches search and notifications,
                          a muted lane is a timeline preference that reaches feeds
                          only. */ LGroupedSectionItem(
              t('lanes.muted.title', { defaultValue: 'Muted lanes' }),
            )
              .wrapControl()
              .description(
                t('lanes.muted.settingsDesc', {
                  defaultValue: 'Hide one track of an account you follow',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LButton(Text(t('common.open', { defaultValue: 'Open' })))
                        .size('sm')
                        .style('subtle')
                        .tint('neutral')
                        .onPress(() => router.push('/settings/privacy/muted-lanes'))
                        .label(
                          t('lanes.muted.title', {
                            defaultValue: 'Muted lanes',
                          }),
                        ),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(t('settings.privacy.hideLikeShareCounts'))
              .wrapControl()
              .description(
                t('settings.privacy.hideLikeShareCountsDesc', {
                  defaultValue: 'Hide engagement counts on posts',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LButton(Text(t('common.open', { defaultValue: 'Open' })))
                        .size('sm')
                        .style('subtle')
                        .tint('neutral')
                        .onPress(() => router.push('/settings/privacy/hide-counts'))
                        .label(t('settings.privacy.hideLikeShareCounts')),
                    )}
                  </>,
                ),
              ),
          ),
        ),
        LSettingsSection(
          t('settings.privacy.content'),
          LGroupedSection(
            LGroupedSectionItem(t('settings.privacy.showSensitiveContent'))
              .wrapControl()
              .description(
                t('settings.privacy.showSensitiveContentDesc', {
                  defaultValue:
                    "Sensitive and NSFW posts never appear in your feeds. They remain visible on the author's profile.",
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([
                        privacySettings.showSensitiveContent ?? false,
                        (value) => updatePrivacyToggle('showSensitiveContent', value),
                      ]),
                    )}
                  </>,
                ),
              ),
          ),
        ),
        LSettingsSection(
          undefined,
          LGroupedSection(
            Embed(
              FILTER_TOGGLES.map(
                ({ icon, titleKey, descKey, titleDefault, descDefault, filterKey }) =>
                  toElement(
                    LGroupedSectionItem(t(titleKey, { defaultValue: titleDefault }))
                      .wrapControl()
                      .description(t(descKey, { defaultValue: descDefault }))
                      .trailing(
                        Embed(
                          <>
                            {toElement(
                              Toggle([recFilters[filterKey], (v) => updateRecFilter(filterKey, v)]),
                            )}
                          </>,
                        ),
                      ),
                    filterKey,
                  ),
              ),
            ),
          ),
        ),
      ).spacing('lg'),
    ).spacing('lg'),
  );
}

export default function AvailablePrivacySettingsScreen() {
  return (
    <SupervisedFeatureGate>
      <PrivacySettingsScreen />
    </SupervisedFeatureGate>
  );
}
