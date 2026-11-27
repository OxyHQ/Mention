// DEV ONLY: Settings -> Notifications as it shipped before the `.bloom` port
// (components/settings/pages/notifications.tsx at 815844431, verbatim), kept to
// measure against the port (`../README.md`).
import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import { useSettingsRouter as useRouter } from '@/context/MentionSettingsContext';
import { useViewerSettingsSection } from '@/hooks/useViewerSettings';
import { toast } from '@oxy.so/bloom/toast';
import { logger } from '@oxy.so/core/logger';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button as LButton,
  Embed,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  Loading as LLoading,
  SettingsSection as LSettingsSection,
  Text,
  Toggle,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

interface NotificationPreferences {
  pushEnabled: boolean;
  likes: boolean;
  boosts: boolean;
  follows: boolean;
  mentions: boolean;
  replies: boolean;
  quotes: boolean;
}

const DEFAULT_PREFS: NotificationPreferences = {
  pushEnabled: true,
  likes: true,
  boosts: true,
  follows: true,
  mentions: true,
  replies: true,
  quotes: true,
};

export default function NotificationSettingsScreen() {
  const { t } = useTranslation();
  const router = useRouter();

  const { canUsePrivateApi, isPrivateApiPending } = useAuth();

  const {
    value: stored,
    isLoading: loading,
    update,
  } = useViewerSettingsSection('notificationPreferences');
  const prefs: NotificationPreferences = { ...DEFAULT_PREFS, ...stored };
  const [saving, setSaving] = useState(false);

  const updatePreference = useCallback(
    async (key: keyof NotificationPreferences, value: boolean) => {
      try {
        setSaving(true);
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
    },
    [update, t],
  );

  if (isPrivateApiPending) {
    return toElement(VStack(Embed(<SettingsSkeleton />)).spacing('lg'));
  }

  if (!canUsePrivateApi) {
    return toElement(
      VStack(
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
      ).spacing('lg'),
    );
  }

  if (loading) {
    return toElement(VStack(Embed(<SettingsSkeleton />)).spacing('lg'));
  }

  return toElement(
    VStack(
      saving ? LLoading().style('inline').size('sm') : null,
      VStack(
        LSettingsSection(
          t('settings.notifications.sections.general', {
            defaultValue: 'General',
          }),
          LGroupedSection(
            LGroupedSectionItem(
              t('settings.notifications.push', {
                defaultValue: 'Push notifications',
              }),
            )
              .wrapControl()
              .description(
                t('settings.notifications.pushDesc', {
                  defaultValue: 'Receive push notifications on your device',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([prefs.pushEnabled, (v) => updatePreference('pushEnabled', v)]).label(
                        t('settings.notifications.push', {
                          defaultValue: 'Push notifications',
                        }),
                      ),
                    )}
                  </>,
                ),
              ),
          ),
        ),
        LSettingsSection(
          t('settings.notifications.sections.activity', {
            defaultValue: 'Activity from others',
          }),
          LGroupedSection(
            LGroupedSectionItem(
              t('subscription.list.title', {
                defaultValue: 'Activity notifications',
              }),
            )
              .wrapControl()
              .description(
                t('subscription.list.entryDesc', {
                  defaultValue: 'Accounts that notify you when they post',
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
                        .onPress(() => router.push('/settings/notifications/subscriptions'))
                        .label(
                          t('subscription.list.title', {
                            defaultValue: 'Activity notifications',
                          }),
                        ),
                    )}
                  </>,
                ),
              ),
          ),
        ),
        LSettingsSection(
          t('settings.notifications.sections.types', {
            defaultValue: 'Notification types',
          }),
          LGroupedSection(
            LGroupedSectionItem(
              t('settings.notifications.likes', {
                defaultValue: 'Likes',
              }),
            )
              .wrapControl()
              .description(
                t('settings.notifications.likesDesc', {
                  defaultValue: 'When someone likes your post',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([prefs.likes, (v) => updatePreference('likes', v)]).label(
                        t('settings.notifications.likes', {
                          defaultValue: 'Likes',
                        }),
                      ),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(
              t('settings.notifications.boosts', {
                defaultValue: 'Boosts',
              }),
            )
              .wrapControl()
              .description(
                t('settings.notifications.boostsDesc', {
                  defaultValue: 'When someone boosts your post',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([prefs.boosts, (v) => updatePreference('boosts', v)]).label(
                        t('settings.notifications.boosts', {
                          defaultValue: 'Boosts',
                        }),
                      ),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(
              t('settings.notifications.follows', {
                defaultValue: 'New followers',
              }),
            )
              .wrapControl()
              .description(
                t('settings.notifications.followsDesc', {
                  defaultValue: 'When someone follows you',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([prefs.follows, (v) => updatePreference('follows', v)]).label(
                        t('settings.notifications.follows', {
                          defaultValue: 'New followers',
                        }),
                      ),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(
              t('settings.notifications.mentions', {
                defaultValue: 'Mentions',
              }),
            )
              .wrapControl()
              .description(
                t('settings.notifications.mentionsDesc', {
                  defaultValue: 'When someone mentions you in a post',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([prefs.mentions, (v) => updatePreference('mentions', v)]).label(
                        t('settings.notifications.mentions', {
                          defaultValue: 'Mentions',
                        }),
                      ),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(
              t('settings.notifications.replies', {
                defaultValue: 'Replies',
              }),
            )
              .wrapControl()
              .description(
                t('settings.notifications.repliesDesc', {
                  defaultValue: 'When someone replies to your post',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([prefs.replies, (v) => updatePreference('replies', v)]).label(
                        t('settings.notifications.replies', {
                          defaultValue: 'Replies',
                        }),
                      ),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(
              t('settings.notifications.quotes', {
                defaultValue: 'Quote posts',
              }),
            )
              .wrapControl()
              .description(
                t('settings.notifications.quotesDesc', {
                  defaultValue: 'When someone quotes your post',
                }),
              )
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([prefs.quotes, (v) => updatePreference('quotes', v)]).label(
                        t('settings.notifications.quotes', {
                          defaultValue: 'Quote posts',
                        }),
                      ),
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
