// DEV ONLY: Settings -> Notifications hand-written in the embedded language at its
// best (`../README.md`): a `view()` body, as `docs/bloom-language-for-agents.mdx`
// writes one and as the `.bloom` port compiles to, with no `Embed(<>{toElement()}</>)`
// around the trailing controls, a row helper and no hand memoisation (the React
// Compiler memoises it, as Mention builds it). Kept to measure against the port.
import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import { useSettingsRouter } from '@/context/MentionSettingsContext';
import { useViewerSettingsSection } from '@/hooks/useViewerSettings';
import { logger } from '@oxy.so/core/logger';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Embed, Loading, Text, VStack, toast, view } from '@oxy.so/bloom-language';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom-language/containers';
import { Toggle } from '@oxy.so/bloom-language/inputs';
import { SettingsSection } from '@oxy.so/bloom-language/settings';

interface NotificationPreferences {
  pushEnabled: boolean;
  likes: boolean;
  boosts: boolean;
  follows: boolean;
  mentions: boolean;
  replies: boolean;
  quotes: boolean;
}
type PrefKey = keyof NotificationPreferences;

const DEFAULT_PREFS: NotificationPreferences = {
  pushEnabled: true,
  likes: true,
  boosts: true,
  follows: true,
  mentions: true,
  replies: true,
  quotes: true,
};

export const NotificationSettingsScreen = view(function NotificationSettingsScreen() {
  const { t } = useTranslation();
  const router = useSettingsRouter();
  const { canUsePrivateApi, isPrivateApiPending } = useAuth();
  const { value: stored, isLoading, update } = useViewerSettingsSection('notificationPreferences');
  const prefs: NotificationPreferences = { ...DEFAULT_PREFS, ...stored };
  const [saving, setSaving] = useState(false);

  const updatePreference = async (key: PrefKey, value: boolean) => {
    setSaving(true);
    try {
      await update({ [key]: value });
    } catch (error) {
      logger.error('Error updating notification preferences', error);
      toast(
        t('settings.notifications.saveError', {
          defaultValue: 'Failed to save notification preference',
        }),
        { type: 'error' },
      );
    } finally {
      setSaving(false);
    }
  };

  const toggleRow = (key: PrefKey, title: string, description: string) =>
    GroupedSectionItem(title)
      .wrapControl()
      .description(description)
      .trailing(Toggle([prefs[key], (on: boolean) => void updatePreference(key, on)]).label(title));

  if (isPrivateApiPending || (canUsePrivateApi && isLoading)) {
    return VStack(Embed(<SettingsSkeleton />)).spacing('lg');
  }

  if (!canUsePrivateApi) {
    return VStack(
      Embed(
        <OxyAuthPrompt
          label={t('settings.notifications.signInRequired', {
            defaultValue: 'Sign in to manage notifications',
          })}
          description={t('settings.notifications.signInRequiredDesc', {
            defaultValue: 'Choose what alerts you receive and how.',
          })}
        />,
      ),
    ).spacing('lg');
  }

  return VStack(
    saving ? Loading().style('inline').size('sm') : null,
    VStack(
      SettingsSection(
        t('settings.notifications.sections.general', { defaultValue: 'General' }),
        GroupedSection(
          toggleRow(
            'pushEnabled',
            t('settings.notifications.push', { defaultValue: 'Push notifications' }),
            t('settings.notifications.pushDesc', {
              defaultValue: 'Receive push notifications on your device',
            }),
          ),
        ),
      ),
      SettingsSection(
        t('settings.notifications.sections.activity', { defaultValue: 'Activity from others' }),
        GroupedSection(
          GroupedSectionItem(
            t('subscription.list.title', { defaultValue: 'Activity notifications' }),
          )
            .wrapControl()
            .description(
              t('subscription.list.entryDesc', {
                defaultValue: 'Accounts that notify you when they post',
              }),
            )
            .trailing(
              Button(Text(t('common.open', { defaultValue: 'Open' })))
                .size('sm')
                .style('subtle')
                .tint('neutral')
                .onPress(() => router.push('/settings/notifications/subscriptions'))
                .label(t('subscription.list.title', { defaultValue: 'Activity notifications' })),
            ),
        ),
      ),
      SettingsSection(
        t('settings.notifications.sections.types', { defaultValue: 'Notification types' }),
        GroupedSection(
          toggleRow(
            'likes',
            t('settings.notifications.likes', { defaultValue: 'Likes' }),
            t('settings.notifications.likesDesc', { defaultValue: 'When someone likes your post' }),
          ),
          toggleRow(
            'boosts',
            t('settings.notifications.boosts', { defaultValue: 'Boosts' }),
            t('settings.notifications.boostsDesc', {
              defaultValue: 'When someone boosts your post',
            }),
          ),
          toggleRow(
            'follows',
            t('settings.notifications.follows', { defaultValue: 'New followers' }),
            t('settings.notifications.followsDesc', { defaultValue: 'When someone follows you' }),
          ),
          toggleRow(
            'mentions',
            t('settings.notifications.mentions', { defaultValue: 'Mentions' }),
            t('settings.notifications.mentionsDesc', {
              defaultValue: 'When someone mentions you in a post',
            }),
          ),
          toggleRow(
            'replies',
            t('settings.notifications.replies', { defaultValue: 'Replies' }),
            t('settings.notifications.repliesDesc', {
              defaultValue: 'When someone replies to your post',
            }),
          ),
          toggleRow(
            'quotes',
            t('settings.notifications.quotes', { defaultValue: 'Quote posts' }),
            t('settings.notifications.quotesDesc', {
              defaultValue: 'When someone quotes your post',
            }),
          ),
        ),
      ),
    ).spacing('lg'),
  ).spacing('lg');
});
