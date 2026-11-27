import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import {
  FOR_YOU_TUNING_MODULES,
  type ForYouFeedTuning,
  type ForYouTuningModuleSpec,
} from '@mention/shared-types/mtn/feedTuning';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useForYouTuning } from '@/hooks/useForYouTuning';
import { resolveTuning, updateTuning } from '@/utils/forYouTuning';

import { Embed, RawText, VStack, toElement } from '@oxy.so/bloom-language';
import {
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
} from '@oxy.so/bloom-language/containers';
import { Toggle } from '@oxy.so/bloom-language/inputs';
import { SettingsSection as LSettingsSection } from '@oxy.so/bloom-language/settings';
import { Slider as LSlider } from '@oxy.so/bloom-language/slider';

type TuningCategory = ForYouTuningModuleSpec['category'];

/** Category display order for the tuning groups. */
const CATEGORY_ORDER: readonly TuningCategory[] = ['safety', 'quality', 'engagement', 'content'];

interface TuningCategoryGroup {
  category: TuningCategory;
  modules: ForYouTuningModuleSpec[];
}

/** Group the tunable modules by category, preserving spec order within a group. */
function groupByCategory(): TuningCategoryGroup[] {
  const byCategory = new Map<TuningCategory, ForYouTuningModuleSpec[]>();
  for (const spec of FOR_YOU_TUNING_MODULES) {
    const list = byCategory.get(spec.category) ?? [];
    list.push(spec);
    byCategory.set(spec.category, list);
  }
  return CATEGORY_ORDER.filter((category) => byCategory.has(category)).map((category) => ({
    category,
    modules: byCategory.get(category) ?? [],
  }));
}

/** One tunable module: an on/off toggle plus a threshold slider when enabled. */
function TuningModuleRow({
  spec,
  tuning,
  onSave,
}: {
  spec: ForYouTuningModuleSpec;
  tuning: ForYouFeedTuning;
  onSave: (next: ForYouFeedTuning) => void;
}) {
  const { t } = useTranslation();
  const { enabled, threshold } = resolveTuning(tuning, spec);
  // A toggle-only module has no threshold, so it renders the switch and nothing
  // else. Reading `spec.step` unconditionally is what the discriminated union in
  // `FOR_YOU_TUNING_MODULES` exists to prevent.
  const range = spec.control === 'number-range' ? spec : undefined;
  const stepIsFractional = range !== undefined && range.step < 1;

  return (
    <>
      {toElement(
        LGroupedSectionItem(t(spec.labelKey))
          .wrapControl()
          .description(t(spec.descriptionKey))
          .trailing(
            Embed(
              <>
                {toElement(
                  Toggle([
                    enabled,
                    (value) => onSave(updateTuning(tuning, spec, { enabled: value, threshold })),
                  ]).label(t(spec.labelKey)),
                )}
              </>,
            ),
          ),
      )}
      {enabled && range !== undefined && threshold !== undefined
        ? toElement(
            VStack(
              LSlider(
                [
                  threshold,
                  (value) =>
                    onSave(
                      updateTuning(tuning, spec, {
                        enabled: true,
                        threshold: stepIsFractional ? value : Math.round(value),
                      }),
                    ),
                ],
                t('feed.tuning.threshold', { defaultValue: 'Threshold' }),
              )
                .bounds(range.min, range.max)
                .step(range.step)
                .valueFormat((value) =>
                  stepIsFractional ? value.toFixed(2) : String(Math.round(value)),
                ),
            )
              .padding('horizontal', 'xl')
              .padding('bottom', 'md'),
          )
        : null}
    </>
  );
}

/**
 * Settings → For You. Per-user overrides for the For You discovery gate, rendered
 * data-driven from `FOR_YOU_TUNING_MODULES` (the shared spec that also validates
 * the payload server-side). Toggles enable/disable a gate module; sliders tune its
 * threshold. Writes go to `PUT /feed/tuning` via {@link useForYouTuning} (optimistic
 * + invalidate); the config-default gate applies for anything left untouched.
 */
export default function ForYouTuningScreen() {
  const { t } = useTranslation();

  const { isAuthenticated } = useAuth();
  const { tuning, save, isLoading } = useForYouTuning();

  const groups = useMemo(() => groupByCategory(), []);

  if (!isAuthenticated) {
    return toElement(
      VStack(
        Embed(
          <OxyAuthPrompt
            label={t('feed.tuning.signInRequired', {
              defaultValue: 'Sign in to tune your For You feed',
            })}
            description={t('feed.tuning.signInRequiredDesc', {
              defaultValue:
                'Adjust which quality, engagement, and content filters shape your discovery feed.',
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
      VStack(
        VStack(
          RawText(
            t('feed.tuning.intro', {
              defaultValue:
                'These filters shape only your For You discovery feed. Accounts you follow are never filtered.',
            }),
          )
            .font('sm')
            .leading('18px')
            .foreground('muted'),
        )
          .padding('top', 'sm')
          .padding('bottom', 'xs'),
        Embed(
          groups.map((group) =>
            toElement(
              LSettingsSection(
                t(`feed.tuning.categories.${group.category}`),
                LGroupedSection(
                  Embed(
                    group.modules.map((spec) => (
                      <TuningModuleRow
                        key={spec.moduleId}
                        spec={spec}
                        tuning={tuning}
                        onSave={save}
                      />
                    )),
                  ),
                ),
              ),
              group.category,
            ),
          ),
        ),
      ).spacing('lg'),
    ).spacing('lg'),
  );
}
