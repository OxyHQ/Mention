import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import { DEFAULT_FEED_SETTINGS, useFeedSettings, type FeedSettings } from '@/hooks/useFeedSettings';
import { confirmDialog } from '@/utils/alerts';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button as LButton,
  Embed,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  Loading as LLoading,
  RawText,
  SettingsSection as LSettingsSection,
  SettingsSelect as LSettingsSelect,
  Slider as LSlider,
  Text as LText,
  Toggle,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

const PRESETS = {
  mostRecent: {
    name: 'Most Recent',
    settings: {
      diversity: {
        enabled: false,
        sameAuthorPenalty: 1.0,
        sameTopicPenalty: 1.0,
      },
      recency: { halfLifeHours: 72, maxAgeHours: 336 },
      quality: { boostHighQuality: false },
    },
  },
  mostEngaged: {
    name: 'Most Engaged',
    settings: {
      diversity: {
        enabled: true,
        sameAuthorPenalty: 0.98,
        sameTopicPenalty: 0.98,
      },
      recency: { halfLifeHours: 12, maxAgeHours: 168 },
      quality: { boostHighQuality: true },
    },
  },
  balanced: {
    name: 'Balanced',
    settings: DEFAULT_FEED_SETTINGS,
  },
  diverse: {
    name: 'Diverse',
    settings: {
      diversity: {
        enabled: true,
        sameAuthorPenalty: 0.85,
        sameTopicPenalty: 0.8,
      },
      recency: { halfLifeHours: 24, maxAgeHours: 168 },
      quality: { boostHighQuality: true },
    },
  },
};

export default function FeedSettingsScreen() {
  const { t } = useTranslation();

  const { isAuthenticated } = useAuth();
  // Server state is the only state — every control below writes straight
  // through, so there is no draft to reconcile and no save button.
  const { settings, isLoading, isSaving, preview, save } = useFeedSettings();

  /** Merge a partial change onto the current settings. */
  const merged = useCallback(
    (updates: Partial<FeedSettings>): FeedSettings => ({
      ...settings,
      ...updates,
      following: { ...settings.following, ...updates.following },
      diversity: { ...settings.diversity, ...updates.diversity },
      recency: { ...settings.recency, ...updates.recency },
      quality: { ...settings.quality, ...updates.quality },
    }),
    [settings],
  );

  /** A discrete control (toggle, preset) — persist immediately. */
  const commit = useCallback(
    (updates: Partial<FeedSettings>) => {
      save(merged(updates));
    },
    [merged, save],
  );

  /**
   * A slider mid-drag. `onValueChange` fires every frame, so showing the value
   * and persisting it are separate: this only moves the displayed value, and the
   * matching `onSlidingComplete` persists once on release.
   */
  const previewChange = useCallback(
    (updates: Partial<FeedSettings>) => {
      preview(merged(updates));
    },
    [merged, preview],
  );

  const applyPreset = useCallback(
    (presetKey: keyof typeof PRESETS) => {
      const preset = PRESETS[presetKey];
      save({
        ...DEFAULT_FEED_SETTINGS,
        ...preset.settings,
        following: settings.following,
        diversity: {
          ...DEFAULT_FEED_SETTINGS.diversity,
          ...preset.settings.diversity,
        },
        recency: {
          ...DEFAULT_FEED_SETTINGS.recency,
          ...preset.settings.recency,
        },
        quality: {
          ...DEFAULT_FEED_SETTINGS.quality,
          ...preset.settings.quality,
        },
      });
    },
    [save, settings.following],
  );

  const resetToDefaults = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t('settings.feed.resetToDefaults'),
      message: t('settings.feed.resetToDefaultsMessage'),
      okText: t('common.reset'),
      cancelText: t('common.cancel'),
      destructive: true,
    });
    if (confirmed) {
      save(DEFAULT_FEED_SETTINGS);
    }
  }, [save, t]);

  if (!isAuthenticated) {
    return toElement(
      VStack(
        Embed(
          <OxyAuthPrompt
            label={t('settings.feed.signInRequired', {
              defaultValue: 'Sign in to customize your feed',
            })}
            description={t('settings.feed.signInRequiredDesc', {
              defaultValue: 'Tune the algorithm, diversity, and recency to your taste.',
            })}
          />,
        ),
      ).spacing('lg'),
    );
  }

  if (isLoading) {
    return toElement(VStack(Embed(<SettingsSkeleton />)).spacing('lg'));
  }

  return toElement(
    VStack(
      isSaving ? LLoading().style('inline').size('sm') : null,
      VStack(
        LSettingsSection(
          t('settings.feed.following.title'),
          LGroupedSection(
            LGroupedSectionItem(t('settings.feed.following.order'))
              .wrapControl()
              .description(t('settings.feed.following.description'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LSettingsSelect(
                        t('settings.feed.following.order'),
                        [settings.following.sort, (sort) => commit({ following: { sort } })],
                        [
                          {
                            value: 'chronological',
                            label: t('settings.feed.following.chronological'),
                          },
                          { value: 'relevance', label: t('settings.feed.following.relevance') },
                        ],
                      ),
                    )}
                  </>,
                ),
              ),
          ),
        ),
        /* Presets */ LSettingsSection(
          t('settings.feed.presets.title'),
          LGroupedSection(
            Embed(
              (Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((key) =>
                toElement(
                  LGroupedSectionItem(PRESETS[key].name)
                    .wrapControl()
                    .description(t(`settings.feed.presets.${key}Desc`))
                    .trailing(
                      Embed(
                        <>
                          {toElement(
                            LButton(LText(t('common.open', { defaultValue: 'Open' })))
                              .size('sm')
                              .style('subtle')
                              .tint('neutral')
                              .onPress(() => applyPreset(key))
                              .label(PRESETS[key].name),
                          )}
                        </>,
                      ),
                    ),
                  key,
                ),
              ),
            ),
          ),
        ),
        /* Diversity */ LSettingsSection(
          t('settings.feed.diversity.title'),
          LGroupedSection(
            LGroupedSectionItem(t('settings.feed.diversity.enabled'))
              .wrapControl()
              .description(t('settings.feed.diversity.enabledDesc'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([
                        settings.diversity.enabled,
                        (value) =>
                          commit({
                            diversity: { ...settings.diversity, enabled: value },
                          }),
                      ]).label(t('settings.feed.diversity.enabled')),
                    )}
                  </>,
                ),
              ),
          ),
        ),
        Embed(
          settings.diversity.enabled &&
            toElement(
              VStack(
                VStack(
                  LSlider(
                    [
                      settings.diversity.sameAuthorPenalty,
                      (value) =>
                        previewChange({
                          diversity: {
                            ...settings.diversity,
                            sameAuthorPenalty: value,
                          },
                        }),
                    ],
                    t('settings.feed.diversity.sameAuthorPenalty'),
                  )
                    .onCommit((value) =>
                      commit({
                        diversity: {
                          ...settings.diversity,
                          sameAuthorPenalty: value,
                        },
                      }),
                    )
                    .bounds(0.5, 1)
                    .step(0.01)
                    .valueFormat((v) => v.toFixed(2)),
                  RawText(t('settings.feed.diversity.sameAuthorPenaltyDesc'))
                    .font('xs')
                    .leading('16px')
                    .margin('top', 'xs')
                    .foreground('muted'),
                ),
                VStack(
                  LSlider(
                    [
                      settings.diversity.sameTopicPenalty,
                      (value) =>
                        previewChange({
                          diversity: {
                            ...settings.diversity,
                            sameTopicPenalty: value,
                          },
                        }),
                    ],
                    t('settings.feed.diversity.sameTopicPenalty'),
                  )
                    .onCommit((value) =>
                      commit({
                        diversity: {
                          ...settings.diversity,
                          sameTopicPenalty: value,
                        },
                      }),
                    )
                    .bounds(0.5, 1)
                    .step(0.01)
                    .valueFormat((v) => v.toFixed(2)),
                  RawText(t('settings.feed.diversity.sameTopicPenaltyDesc'))
                    .font('xs')
                    .leading('16px')
                    .margin('top', 'xs')
                    .foreground('muted'),
                ),
              )
                .padding('vertical', 'md')
                .spacing('lg'),
            ),
        ),
        /* Recency */ LSettingsSection(
          t('settings.feed.recency.title'),
          LGroupedSection(
            VStack(
              VStack(
                LSlider(
                  [
                    settings.recency.halfLifeHours,
                    (value) =>
                      previewChange({
                        recency: {
                          ...settings.recency,
                          halfLifeHours: Math.round(value),
                        },
                      }),
                  ],
                  t('settings.feed.recency.halfLifeHours'),
                )
                  .onCommit((value) =>
                    commit({
                      recency: {
                        ...settings.recency,
                        halfLifeHours: Math.round(value),
                      },
                    }),
                  )
                  .bounds(6, 72)
                  .step(1)
                  .valueFormat((v) => `${Math.round(v)} ${t('settings.feed.recency.hours')}`),
                RawText(t('settings.feed.recency.halfLifeHoursDesc'))
                  .font('xs')
                  .leading('16px')
                  .margin('top', 'xs')
                  .foreground('muted'),
              ),
              VStack(
                LSlider(
                  [
                    settings.recency.maxAgeHours,
                    (value) =>
                      previewChange({
                        recency: {
                          ...settings.recency,
                          maxAgeHours: Math.round(value),
                        },
                      }),
                  ],
                  t('settings.feed.recency.maxAgeHours'),
                )
                  .onCommit((value) =>
                    commit({
                      recency: {
                        ...settings.recency,
                        maxAgeHours: Math.round(value),
                      },
                    }),
                  )
                  .bounds(24, 336)
                  .step(24)
                  .valueFormat((v) => `${Math.round(v / 24)} ${t('settings.feed.recency.days')}`),
                RawText(t('settings.feed.recency.maxAgeHoursDesc'))
                  .font('xs')
                  .leading('16px')
                  .margin('top', 'xs')
                  .foreground('muted'),
              ),
            )
              .padding('vertical', 'md')
              .spacing('lg'),
          ),
        ),
        /* Quality */ LSettingsSection(
          t('settings.feed.quality.title'),
          LGroupedSection(
            LGroupedSectionItem(t('settings.feed.quality.boostHighQuality'))
              .wrapControl()
              .description(t('settings.feed.quality.boostHighQualityDesc'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([
                        settings.quality.boostHighQuality,
                        (value) =>
                          commit({
                            quality: { ...settings.quality, boostHighQuality: value },
                          }),
                      ]).label(t('settings.feed.quality.boostHighQuality')),
                    )}
                  </>,
                ),
              ),
          ),
        ),
        /* Reset */ LSettingsSection(
          undefined,
          LGroupedSection(
            LGroupedSectionItem(t('settings.feed.resetToDefaults'))
              .wrapControl()
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LButton(LText(t('common.open', { defaultValue: 'Open' })))
                        .size('sm')
                        .style('subtle')
                        .tint('danger')
                        .onPress(resetToDefaults)
                        .label(t('settings.feed.resetToDefaults')),
                    )}
                  </>,
                ),
              ),
          ),
        ),
      ).spacing('lg'),
    ).spacing('lg'),
  );
}
