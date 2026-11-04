import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import { TopicPicker } from '@/components/interests/TopicPicker';
import { Search } from '@oxy.so/bloom/search';
import { SettingsCard, SettingsSection } from '@oxy.so/bloom/settings-modal';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

/**
 * Your interests — a searchable grid of topics, where selecting one FOLLOWS it.
 *
 * This screen used to write a list of slugs to `interests.tags` on the profile
 * settings. Nothing read that field: the feed learns topics from behaviour, not
 * from it. A chip now creates a real edge in the user-owned follow graph
 * instead, which every Oxy application shares — so a topic picked here is picked
 * everywhere, and giving it up here gives it up everywhere.
 *
 * `interests.tags` is deliberately left alone rather than migrated or
 * dual-written. Writing both would make two sources of truth for one intention,
 * and whichever one a future reader picked would be a coin flip.
 *
 * The topics are Oxy's (`GET /topics` proxies to the Oxy API) and so is the kind
 * — `oxy.topic` is seeded as a platform kind — so Mention registers nothing at
 * all here. See `services/followGraph.ts`. The grid itself is
 * {@link TopicPicker}, shared with the first-run `/welcome` flow.
 */
export default function InterestsSettingsScreen() {
  const { t } = useTranslation();

  const { canUsePrivateApi, isPrivateApiPending } = useAuth();

  const [query, setQuery] = useState('');

  if (isPrivateApiPending) {
    return (
      <View className="gap-4">
        <SettingsSkeleton />
      </View>
    );
  }

  if (!canUsePrivateApi) {
    return (
      <View className="gap-4">
        <OxyAuthPrompt
          label={t('settings.interests.signInRequired', {
            defaultValue: 'Sign in to choose your interests',
          })}
          description={t('settings.interests.signInRequiredDesc', {
            defaultValue: 'Pick topics so we can tailor your feed.',
          })}
        />
      </View>
    );
  }

  return (
    <View className="gap-4">
      <View className="gap-4">
        <View className="pb-2">
          <Search
            value={query}
            onValueChange={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t('settings.interests.searchPlaceholder', {
              defaultValue: 'Search topics',
            })}
            accessibilityLabel={t('settings.interests.searchLabel', {
              defaultValue: 'Search topics',
            })}
            label={t('settings.interests.searchLabel', {
              defaultValue: 'Search topics',
            })}
            onClearText={() => setQuery('')}
          />
        </View>

        <SettingsSection
          label={t('settings.interests.title', {
            defaultValue: 'Your interests',
          })}
          description={t('settings.interests.description', {
            defaultValue: 'Topics you follow shape your feed, and come with you to every Oxy app.',
          })}
        >
          <SettingsCard>
            <TopicPicker query={query} />
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
