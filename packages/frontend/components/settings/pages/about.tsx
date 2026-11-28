import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { LogoIcon } from '@/assets/logo';
import { useTheme } from '@oxy.so/bloom/theme';
import {
  API_URL,
  INSTANCE_ABOUT,
  INSTANCE_LOGO_URL,
  INSTANCE_NAME,
  INSTANCE_REVISION,
  INSTANCE_SOURCE_URL,
  WEB_BASE_URL,
} from '@/config';
import {
  useMentionSettings,
  useSettingsRouter as useRouter,
} from '@/context/MentionSettingsContext';
import { alertDialog, confirmDialog } from '@/utils/alerts';
import { openExternalLink } from '@/utils/openExternalLink';
import { Button } from '@oxy.so/bloom/button';
import { SettingsSection, SettingsValueField } from '@oxy.so/bloom/settings-modal';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import Constants from 'expo-constants';
import { useTranslation } from 'react-i18next';
import { Image, Text, View } from 'react-native';

export default function AboutScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();

  const { afterClose } = useMentionSettings();
  const { showBottomSheet } = useAuth() as {
    showBottomSheet?: (screen: string) => void;
  };

  const appVersion = Constants.expoConfig?.version || '1.0.0';
  const runtimeVersion =
    typeof Constants.expoConfig?.runtimeVersion === 'string'
      ? Constants.expoConfig.runtimeVersion
      : t('settings.aboutMention.buildVersion');

  const platformName = Constants.platform?.ios
    ? 'iOS'
    : Constants.platform?.android
      ? 'Android'
      : 'Web';

  const expoSdkVersion =
    Constants.expoConfig?.sdkVersion ||
    (typeof Constants.expoConfig?.runtimeVersion === 'string'
      ? Constants.expoConfig.runtimeVersion
      : undefined) ||
    'Unknown';

  const oxySdkVersion =
    Constants.expoConfig?.extra?.oxyVersion ||
    Constants.expoConfig?.extra?.oxySDKVersion ||
    'Unknown';

  const apiUrl = API_URL;

  const handleClearCache = async () => {
    const confirmed = await confirmDialog({
      title: t('settings.data.clearCache'),
      message: t('settings.data.clearCacheMessage'),
      okText: t('common.clear'),
      cancelText: t('common.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    await alertDialog({
      title: t('common.success'),
      message: t('settings.data.clearCacheSuccess'),
    });
  };

  return (
    <View className="gap-4">
      <View className="gap-4">
        {/* App identity */}
        <View className="items-center py-6 mb-4">
          <View className="w-16 h-16 rounded-2xl items-center justify-center bg-primary/10 mb-3">
            {INSTANCE_LOGO_URL ? (
              <Image
                source={{ uri: INSTANCE_LOGO_URL }}
                className="w-12 h-12"
                resizeMode="contain"
                accessibilityLabel={INSTANCE_NAME}
              />
            ) : (
              <LogoIcon size={32} color={colors.primary} />
            )}
          </View>
          <Text className="text-xl font-bold text-foreground">{INSTANCE_NAME}</Text>
          <Text className="text-sm text-muted-foreground mt-1">
            {t('settings.aboutMention.version', { version: appVersion })}
          </Text>
        </View>

        {INSTANCE_ABOUT ? (
          <Text className="text-center text-muted-foreground mb-4">{INSTANCE_ABOUT}</Text>
        ) : null}
        {INSTANCE_SOURCE_URL ? (
          <SettingsSection>
            <GroupedSection>
              <GroupedSectionItem
                wrapControl
                title={'Mention by Oxy'}
                rightElement={
                  <>
                    <Button
                      size="sm"
                      appearance="subtle"
                      tone="neutral"
                      onPress={() => {
                        void openExternalLink('https://oxy.so');
                      }}
                      accessibilityLabel={'Mention by Oxy'}
                    >
                      {t('common.open', { defaultValue: 'Open' })}
                    </Button>
                  </>
                }
              />
              <GroupedSectionItem
                wrapControl
                title={t('settings.aboutMention.build')}
                rightElement={
                  <>
                    <Button
                      size="sm"
                      appearance="subtle"
                      tone="neutral"
                      onPress={() => {
                        void openExternalLink(INSTANCE_SOURCE_URL);
                      }}
                      accessibilityLabel={t('settings.aboutMention.build')}
                    >
                      {INSTANCE_REVISION.slice(0, 12)}
                    </Button>
                  </>
                }
              />
              <GroupedSectionItem
                wrapControl
                title={INSTANCE_NAME}
                description={WEB_BASE_URL}
                rightElement={
                  <>
                    <Button
                      size="sm"
                      appearance="subtle"
                      tone="neutral"
                      onPress={() => {
                        void openExternalLink(`${WEB_BASE_URL}/.well-known/mention-instance`);
                      }}
                      accessibilityLabel={INSTANCE_NAME}
                    >
                      {t('common.open', { defaultValue: 'Open' })}
                    </Button>
                  </>
                }
              />
            </GroupedSection>
          </SettingsSection>
        ) : null}

        {/* System info */}
        <SettingsSection
          label={t('settings.aboutMention.systemInfo', {
            defaultValue: 'System information',
          })}
        >
          <GroupedSection>
            <GroupedSectionItem
              wrapControl
              title={t('settings.aboutMention.build')}
              rightElement={
                <>
                  <SettingsValueField>{String(runtimeVersion)}</SettingsValueField>
                </>
              }
            />
            <GroupedSectionItem
              wrapControl
              title={t('settings.aboutMention.platform')}
              rightElement={
                <>
                  <SettingsValueField>{platformName}</SettingsValueField>
                </>
              }
            />
            <GroupedSectionItem
              wrapControl
              title={t('settings.aboutMention.expoSDK')}
              rightElement={
                <>
                  <SettingsValueField>{String(expoSdkVersion)}</SettingsValueField>
                </>
              }
            />
            <GroupedSectionItem
              wrapControl
              title={t('settings.aboutMention.oxySDK')}
              rightElement={
                <>
                  <Button
                    size="sm"
                    appearance="subtle"
                    tone="neutral"
                    onPress={() => afterClose(() => showBottomSheet?.('AppInfo'))}
                    accessibilityLabel={t('settings.aboutMention.oxySDK')}
                  >
                    {String(oxySdkVersion)}
                  </Button>
                </>
              }
            />
            <GroupedSectionItem
              wrapControl
              title={t('settings.aboutMention.apiUrl')}
              rightElement={
                <>
                  <SettingsValueField>{apiUrl}</SettingsValueField>
                </>
              }
            />
          </GroupedSection>
        </SettingsSection>

        {/* Moderation policy, stated publicly */}
        <SettingsSection>
          <GroupedSection>
            <GroupedSectionItem
              wrapControl
              title={t('transparency.title')}
              description={t('transparency.list.title')}
              rightElement={
                <>
                  <Button
                    size="sm"
                    appearance="subtle"
                    tone="neutral"
                    onPress={() => router.push('/settings/fediverse/transparency')}
                    accessibilityLabel={t('transparency.title')}
                  >
                    {t('common.open', { defaultValue: 'Open' })}
                  </Button>
                </>
              }
            />
          </GroupedSection>
        </SettingsSection>

        {/* Support */}
        <SettingsSection label={t('settings.sections.supportFeedback')}>
          <GroupedSection>
            <GroupedSectionItem
              wrapControl
              title={t('settings.supportFeedback.helpSupport')}
              description={t('settings.supportFeedback.helpSupportDesc')}
              rightElement={
                <>
                  <Button
                    size="sm"
                    appearance="subtle"
                    tone="neutral"
                    onPress={() => {
                      toast(t('settings.supportFeedback.helpSupportMessage'), {
                        type: 'info',
                      });
                    }}
                    accessibilityLabel={t('settings.supportFeedback.helpSupport')}
                  >
                    {t('common.open', { defaultValue: 'Open' })}
                  </Button>
                </>
              }
            />
            <GroupedSectionItem
              wrapControl
              title={t('settings.supportFeedback.sendFeedback')}
              description={t('settings.supportFeedback.sendFeedbackDesc')}
              rightElement={
                <>
                  <Button
                    size="sm"
                    appearance="subtle"
                    tone="neutral"
                    onPress={async () => {
                      const confirmed = await confirmDialog({
                        title: t('settings.supportFeedback.sendFeedback'),
                        message: t('settings.supportFeedback.sendFeedbackMessage'),
                        okText: t('common.sendFeedback'),
                        cancelText: t('common.cancel'),
                      });
                      if (confirmed) {
                        toast(t('settings.supportFeedback.sendFeedbackThankYou'), {
                          type: 'success',
                        });
                      }
                    }}
                    accessibilityLabel={t('settings.supportFeedback.sendFeedback')}
                  >
                    {t('common.open', { defaultValue: 'Open' })}
                  </Button>
                </>
              }
            />
          </GroupedSection>
        </SettingsSection>

        {/* Debug */}
        <SettingsSection label={t('settings.debug', { defaultValue: 'Debug' })}>
          <GroupedSection>
            <GroupedSectionItem
              wrapControl
              title={t('settings.data.clearCache')}
              description={t('settings.data.clearCacheDesc')}
              rightElement={
                <>
                  <Button
                    size="sm"
                    appearance="subtle"
                    tone="danger"
                    onPress={handleClearCache}
                    accessibilityLabel={t('settings.data.clearCache')}
                  >
                    {t('common.open', { defaultValue: 'Open' })}
                  </Button>
                </>
              }
            />
          </GroupedSection>
        </SettingsSection>
      </View>
    </View>
  );
}
