import React, { useCallback, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { Switch } from '@oxyhq/bloom/switch';
import { show as toast } from '@oxyhq/bloom/toast';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { OxyAuthPrompt, useAuth } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { RowIcon } from '@/components/settings/RowIcon';
import { showFediverseInfo } from '@/components/Fediverse/FediverseInfoDialog';
import LanguagePickerSheet from '@/components/Compose/LanguagePickerSheet';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useFediversePreferredLanguage } from '@/hooks/useFediversePreferredLanguage';
import { describeContentLanguage } from '@/constants/contentLanguages';
import { confirmDialog } from '@/utils/alerts';
import { api } from '@/utils/api';
import { WEB_BASE_URL } from '@/config';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('FediverseSettings');

/**
 * Fediverse-sharing controls. Mounted only once auth is resolved and a private
 * bearer is available, so it reads the current sharing flag straight off the
 * resolved user (no fetch, no effect). Turning sharing off requires a confirm;
 * both directions optimistically update and revert if the Oxy write fails.
 */
function FediverseSharingBody() {
  const { t } = useTranslation();
  const { user, oxyServices } = useAuth();
  const bottomSheet = React.useContext(BottomSheetContext);
  const { preferredLanguage, updatePreferredLanguage } = useFediversePreferredLanguage();

  const [sharing, setSharing] = useState<boolean>(user?.fediverseSharing !== false);
  const [pending, setPending] = useState(false);

  const preferredLabel = preferredLanguage
    ? describeContentLanguage(preferredLanguage).nativeName
    : t('fediverse.settings.preferredLanguage.automatic', { defaultValue: 'Automatic' });

  const applyPreferred = useCallback(
    async (tag: string | null) => {
      try {
        await updatePreferredLanguage(tag);
      } catch (error) {
        logger.error('Failed to update fediverse preferred language', { error });
        toast(
          t('fediverse.settings.updateFailed', {
            defaultValue: "Couldn't update fediverse sharing. Please try again.",
          }),
          { type: 'error' },
        );
      }
    },
    [updatePreferredLanguage, t],
  );

  const openPreferredLanguagePicker = useCallback(() => {
    bottomSheet.setBottomSheetContent(
      <LanguagePickerSheet
        usedTags={[]}
        currentTag={preferredLanguage ?? undefined}
        removeLabel={t('fediverse.settings.preferredLanguage.clear', { defaultValue: 'Use automatic' })}
        onRemove={preferredLanguage ? () => { void applyPreferred(null); } : undefined}
        onSelect={(tag: string) => { void applyPreferred(tag); }}
        onClose={() => bottomSheet.openBottomSheet(false)}
      />,
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet, preferredLanguage, applyPreferred, t]);

  const federatedHandle = user?.username
    ? `@${user.username}@${new URL(WEB_BASE_URL).host}`
    : undefined;

  const applyChange = useCallback(
    async (value: boolean) => {
      setSharing(value);
      setPending(true);
      try {
        await oxyServices.updatePrivacySettings({ fediverseSharing: value });
      } catch (error) {
        logger.error('Failed to update fediverse sharing preference', { error });
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
          logger.warn('sharing-changed notify failed after retry', { error: retryError });
        }
      }
      setPending(false);
    },
    [oxyServices],
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

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="py-2"
      showsVerticalScrollIndicator={false}
    >
      <SettingsListGroup footer={t('fediverse.settings.description')}>
        <SettingsListItem
          icon={<RowIcon name="globe-outline" />}
          title={t('fediverse.settings.share')}
          description={federatedHandle}
          showChevron={false}
          rightElement={
            <Switch value={sharing} onValueChange={onToggle} disabled={pending} />
          }
        />
      </SettingsListGroup>

      <SettingsListGroup
        footer={t('fediverse.settings.preferredLanguage.description', {
          defaultValue:
            'The main language your posts are written in. It becomes the primary version shown across the fediverse; leave it automatic to let it be detected per post.',
        })}
      >
        <SettingsListItem
          icon={<RowIcon name="language-outline" />}
          title={t('fediverse.settings.preferredLanguage.title', { defaultValue: 'Preferred language' })}
          description={preferredLabel}
          onPress={openPreferredLanguagePicker}
        />
      </SettingsListGroup>

      <SettingsListGroup>
        <SettingsListItem
          icon={<RowIcon name="help-circle-outline" />}
          title={t('fediverse.settings.whatIs')}
          onPress={openInfoSheet}
        />
      </SettingsListGroup>
    </ScrollView>
  );
}

export default function FediverseSettingsScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();

  const headerOptions = {
    title: t('fediverse.settings.title'),
    leftComponents: [
      <IconButton variant="icon" key="back" onPress={() => safeBack()}>
        <BackArrowIcon size={20} className="text-foreground" />
      </IconButton>,
    ],
  };

  return (
    <ThemedView className="flex-1">
      <Header options={headerOptions} hideBottomBorder disableSticky />
      {!isAuthResolved || isPrivateApiPending ? (
        <View className="flex-1 items-center justify-center">
          <Loading />
        </View>
      ) : !canUsePrivateApi ? (
        <OxyAuthPrompt
          label={t('fediverse.settings.signInRequired', {
            defaultValue: 'Sign in to manage fediverse sharing',
          })}
          description={t('fediverse.settings.signInRequiredDesc', {
            defaultValue: 'Control whether your profile and posts are shared across the fediverse.',
          })}
        />
      ) : (
        <FediverseSharingBody />
      )}
    </ThemedView>
  );
}
