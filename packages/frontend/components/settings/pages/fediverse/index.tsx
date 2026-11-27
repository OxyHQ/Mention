import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import { showFediverseInfo } from '@/components/Fediverse/FediverseInfoDialog';
import { WEB_BASE_URL } from '@/config';
import { useSettingsRouter as useRouter } from '@/context/MentionSettingsContext';
import { confirmDialog } from '@/utils/alerts';
import { api } from '@/utils/api';
import { toast } from '@oxy.so/bloom/toast';
import { createLogger } from '@oxy.so/core/logger';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as LButton, Embed, Text, VStack, toElement } from '@oxy.so/bloom-language';
import {
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
} from '@oxy.so/bloom-language/containers';
import { Toggle } from '@oxy.so/bloom-language/inputs';
import { SettingsSection as LSettingsSection } from '@oxy.so/bloom-language/settings';

const logger = createLogger('FediverseSettings');

/**
 * The one door to everything fediverse in settings: sharing, the language your
 * posts are published under, your node, and how to read the moderation policy.
 * Anything federation-related that grows a screen of its own belongs under
 * `settings/fediverse/`, not beside this row in the settings index.
 *
 * Mounted only once auth is resolved and a private bearer is available, so it
 * reads the current sharing flag straight off the resolved user (no fetch, no
 * effect). Turning sharing off requires a confirm; both directions
 * optimistically update and revert if the Oxy write fails.
 */
function FediverseSharingBody() {
  const { t } = useTranslation();
  const router = useRouter();
  const { user, oxyServices } = useAuth();

  const [sharing, setSharing] = useState<boolean>(user?.fediverseSharing !== false);
  const [pending, setPending] = useState(false);

  const federatedHandle = user?.username
    ? `@${user.username}@${new URL(WEB_BASE_URL).host}`
    : undefined;

  const applyChange = useCallback(
    async (value: boolean) => {
      setSharing(value);
      setPending(true);
      try {
        await oxyServices.privacy.updateSettings({ fediverseSharing: value });
      } catch (error) {
        logger.error('Failed to update fediverse sharing preference', error);
        setSharing(!value);
        setPending(false);
        toast(
          t('fediverse.settings.updateFailed', {
            defaultValue: "Couldn't update fediverse sharing. Please try again.",
          }),
          { type: 'error' },
        );
        return;
      }
      // Best-effort backend notify: queues remote cleanup when turning off and
      // re-reads the flag from Oxy itself, so it takes no body. One retry.
      try {
        await api.post('/federation/sharing-changed');
      } catch {
        try {
          await api.post('/federation/sharing-changed');
        } catch (retryError) {
          logger.warn('sharing-changed notify failed after retry', {
            error: retryError,
          });
        }
      }
      setPending(false);
    },
    [oxyServices, t],
  );

  const onToggle = useCallback(
    async (value: boolean) => {
      if (!value) {
        const confirmed = await confirmDialog({
          title: t('fediverse.settings.disableConfirm.title'),
          message: t('fediverse.settings.disableConfirm.message'),
          okText: t('fediverse.settings.disableConfirm.confirm'),
          cancelText: t('common.cancel'),
          destructive: true,
        });
        if (!confirmed) return;
      }
      await applyChange(value);
    },
    [applyChange, t],
  );

  const openInfoSheet = useCallback(() => {
    showFediverseInfo({
      showEnableCta: !sharing,
      onEnable: () => {
        void applyChange(true);
      },
    });
  }, [applyChange, sharing]);

  // The row names the handle it federates as, once there is one.
  const shareRow = LGroupedSectionItem(t('fediverse.settings.share')).wrapControl();
  return toElement(
    VStack(
      LSettingsSection(
        undefined,
        LGroupedSection(
          (federatedHandle === undefined
            ? shareRow
            : shareRow.description(federatedHandle)
          ).trailing(Toggle([sharing, onToggle]).disabled(pending)),
        ),
      ).description(t('fediverse.settings.description')),
      LSettingsSection(
        undefined,
        LGroupedSection(
          LGroupedSectionItem(t('fediverse.settings.whatIs'))
            .wrapControl()
            .trailing(
              Embed(
                <>
                  {toElement(
                    LButton(Text(t('common.open', { defaultValue: 'Open' })))
                      .size('sm')
                      .style('subtle')
                      .tint('neutral')
                      .onPress(openInfoSheet)
                      .label(t('fediverse.settings.whatIs')),
                  )}
                </>,
              ),
            ),
          LGroupedSectionItem(t('transparency.title'))
            .wrapControl()
            .description(t('transparency.list.title'))
            .trailing(
              Embed(
                <>
                  {toElement(
                    LButton(Text(t('common.open', { defaultValue: 'Open' })))
                      .size('sm')
                      .style('subtle')
                      .tint('neutral')
                      .onPress(() => router.push('/settings/fediverse/transparency'))
                      .label(t('transparency.title')),
                  )}
                </>,
              ),
            ),
        ),
      ),
    ).spacing('lg'),
  );
}

export default function FediverseSettingsScreen() {
  const { t } = useTranslation();

  const { isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();

  return toElement(
    VStack(
      Embed(
        !isAuthResolved || isPrivateApiPending ? (
          <SettingsSkeleton />
        ) : !canUsePrivateApi ? (
          <OxyAuthPrompt
            label={t('fediverse.settings.signInRequired', {
              defaultValue: 'Sign in to manage fediverse sharing',
            })}
            description={t('fediverse.settings.signInRequiredDesc', {
              defaultValue:
                'Control whether your profile and posts are shared across the fediverse.',
            })}
          />
        ) : (
          <FediverseSharingBody />
        ),
      ),
    ).spacing('lg'),
  );
}
