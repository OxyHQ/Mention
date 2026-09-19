import { useMemo } from 'react';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { View, Text, ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  FOR_YOU_TUNING_MODULES,
  type ForYouFeedTuning,
  type ForYouTuningModuleSpec,
} from '@mention/shared-types/mtn/feedTuning';
import { Loading } from '@oxy.so/bloom/loading';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { useAuth, OxyAuthPrompt } from '@oxy.so/services/ui/client';

import { useSafeBack } from '@/hooks/useSafeBack';
import { Toggle } from '@/components/Toggle';
import { Slider } from '@/components/Slider';
import { useForYouTuning } from '@/hooks/useForYouTuning';
import { resolveTuning, updateTuning } from '@/utils/forYouTuning';

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
      <SettingsListItem
        title={t(spec.labelKey)}
        description={t(spec.descriptionKey)}
        showChevron={false}
        rightElement={
          <Toggle
            value={enabled}
            onValueChange={(value) => onSave(updateTuning(tuning, spec, { enabled: value, threshold }))}
          />
        }
      />
      {enabled && range !== undefined && threshold !== undefined ? (
        <View className="px-5 pb-3">
          <Slider
            value={threshold}
            onValueChange={(value) =>
              onSave(
                updateTuning(tuning, spec, {
                  enabled: true,
                  threshold: stepIsFractional ? value : Math.round(value),
                }),
              )
            }
            minimumValue={range.min}
            maximumValue={range.max}
            step={range.step}
            label={t('feed.tuning.threshold', { defaultValue: 'Threshold' })}
            formatValue={(value) => (stepIsFractional ? value.toFixed(2) : String(Math.round(value)))}
          />
        </View>
      ) : null}
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
  const safeBack = useSafeBack();
  const { isAuthenticated } = useAuth();
  const { tuning, save, isLoading } = useForYouTuning();

  const groups = useMemo(() => groupByCategory(), []);

  const header = (
    <PageHeader title={t('feed.tuning.title', { defaultValue: 'For You' })} onBack={() => safeBack()} backLabel={t('common.back', { defaultValue: 'Back' })} />
  );

  if (!isAuthenticated) {
    return (
      <View className="flex-1">
        {header}
        <OxyAuthPrompt
          label={t('feed.tuning.signInRequired', { defaultValue: 'Sign in to tune your For You feed' })}
          description={t('feed.tuning.signInRequiredDesc', {
            defaultValue: 'Adjust which quality, engagement, and content filters shape your discovery feed.',
          })}
        />
      </View>
    );
  }

  if (isLoading) {
    return (
      <View className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center">
          <Loading className="text-primary" size="large" />
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      {header}
      <ScrollView className="flex-1" contentContainerClassName="px-screen-margin py-2" showsVerticalScrollIndicator={false}>
        <View className="pt-2 pb-1">
          <Text className="text-[13px] leading-[18px] text-muted-foreground">
            {t('feed.tuning.intro', {
              defaultValue:
                'These filters shape only your For You discovery feed. Accounts you follow are never filtered.',
            })}
          </Text>
        </View>

        {groups.map((group) => (
          <SettingsListGroup key={group.category} title={t(`feed.tuning.categories.${group.category}`)}>
            {group.modules.map((spec) => (
              <TuningModuleRow key={spec.moduleId} spec={spec} tuning={tuning} onSave={save} />
            ))}
          </SettingsListGroup>
        ))}
      </ScrollView>
    </View>
  );
}
