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
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import Constants from 'expo-constants';
import { useTranslation } from 'react-i18next';
import { Image } from 'react-native';

import {
  Button as LButton,
  Embed,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  RawText,
  SettingsSection as LSettingsSection,
  SettingsValue,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

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

  return toElement(
    VStack(
      VStack(
        /* App identity */ VStack(
          VStack(
            Embed(
              INSTANCE_LOGO_URL ? (
                <Image
                  source={{ uri: INSTANCE_LOGO_URL }}
                  className="w-12 h-12"
                  resizeMode="contain"
                  accessibilityLabel={INSTANCE_NAME}
                />
              ) : (
                <LogoIcon size={32} color={colors.primary} />
              ),
            ),
          )
            .frame({ width: '64', height: '64' })
            .background('primary/10')
            .corner('lg')
            .align('center')
            .justify('center')
            .margin('bottom', 'md'),
          RawText(INSTANCE_NAME).font('xl').leading('28px').weight('bold').foreground('foreground'),
          RawText(t('settings.aboutMention.version', { version: appVersion }))
            .font('14')
            .leading('20px')
            .foreground('muted')
            .margin('top', 'xs'),
        )
          .padding('vertical', '2xl')
          .align('center')
          .margin('bottom', 'lg'),
        INSTANCE_ABOUT
          ? RawText(INSTANCE_ABOUT).textAlign('center').foreground('muted').margin('bottom', 'lg')
          : null,
        INSTANCE_SOURCE_URL
          ? LSettingsSection(
              undefined,
              LGroupedSection(
                LGroupedSectionItem('Mention by Oxy')
                  .wrapControl()
                  .trailing(
                    Embed(
                      <>
                        {toElement(
                          LButton(LText(t('common.open', { defaultValue: 'Open' })))
                            .size('sm')
                            .style('subtle')
                            .tint('neutral')
                            .onPress(() => {
                              void openExternalLink('https://oxy.so');
                            })
                            .label('Mention by Oxy'),
                        )}
                      </>,
                    ),
                  ),
                LGroupedSectionItem(t('settings.aboutMention.build'))
                  .wrapControl()
                  .trailing(
                    Embed(
                      <>
                        {toElement(
                          LButton(LText(INSTANCE_REVISION.slice(0, 12)))
                            .size('sm')
                            .style('subtle')
                            .tint('neutral')
                            .onPress(() => {
                              void openExternalLink(INSTANCE_SOURCE_URL);
                            })
                            .label(t('settings.aboutMention.build')),
                        )}
                      </>,
                    ),
                  ),
                LGroupedSectionItem(INSTANCE_NAME)
                  .wrapControl()
                  .description(WEB_BASE_URL)
                  .trailing(
                    Embed(
                      <>
                        {toElement(
                          LButton(LText(t('common.open', { defaultValue: 'Open' })))
                            .size('sm')
                            .style('subtle')
                            .tint('neutral')
                            .onPress(() => {
                              void openExternalLink(`${WEB_BASE_URL}/.well-known/mention-instance`);
                            })
                            .label(INSTANCE_NAME),
                        )}
                      </>,
                    ),
                  ),
              ),
            )
          : null,
        /* System info */ LSettingsSection(
          t('settings.aboutMention.systemInfo', {
            defaultValue: 'System information',
          }),
          LGroupedSection(
            LGroupedSectionItem(t('settings.aboutMention.build'))
              .wrapControl()
              .trailing(Embed(<>{toElement(SettingsValue(String(runtimeVersion)))}</>)),
            LGroupedSectionItem(t('settings.aboutMention.platform'))
              .wrapControl()
              .trailing(Embed(<>{toElement(SettingsValue(platformName))}</>)),
            LGroupedSectionItem(t('settings.aboutMention.expoSDK'))
              .wrapControl()
              .trailing(Embed(<>{toElement(SettingsValue(String(expoSdkVersion)))}</>)),
            LGroupedSectionItem(t('settings.aboutMention.oxySDK'))
              .wrapControl()
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LButton(LText(String(oxySdkVersion)))
                        .size('sm')
                        .style('subtle')
                        .tint('neutral')
                        .onPress(() => afterClose(() => showBottomSheet?.('AppInfo')))
                        .label(t('settings.aboutMention.oxySDK')),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(t('settings.aboutMention.apiUrl'))
              .wrapControl()
              .trailing(Embed(<>{toElement(SettingsValue(apiUrl))}</>)),
          ),
        ),
        /* Moderation policy, stated publicly */ LSettingsSection(
          undefined,
          LGroupedSection(
            LGroupedSectionItem(t('transparency.title'))
              .wrapControl()
              .description(t('transparency.list.title'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LButton(LText(t('common.open', { defaultValue: 'Open' })))
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
        /* Support */ LSettingsSection(
          t('settings.sections.supportFeedback'),
          LGroupedSection(
            LGroupedSectionItem(t('settings.supportFeedback.helpSupport'))
              .wrapControl()
              .description(t('settings.supportFeedback.helpSupportDesc'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LButton(LText(t('common.open', { defaultValue: 'Open' })))
                        .size('sm')
                        .style('subtle')
                        .tint('neutral')
                        .onPress(() => {
                          toast(t('settings.supportFeedback.helpSupportMessage'), {
                            type: 'info',
                          });
                        })
                        .label(t('settings.supportFeedback.helpSupport')),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(t('settings.supportFeedback.sendFeedback'))
              .wrapControl()
              .description(t('settings.supportFeedback.sendFeedbackDesc'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LButton(LText(t('common.open', { defaultValue: 'Open' })))
                        .size('sm')
                        .style('subtle')
                        .tint('neutral')
                        .onPress(async () => {
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
                        })
                        .label(t('settings.supportFeedback.sendFeedback')),
                    )}
                  </>,
                ),
              ),
          ),
        ),
        /* Debug */ LSettingsSection(
          t('settings.debug', { defaultValue: 'Debug' }),
          LGroupedSection(
            LGroupedSectionItem(t('settings.data.clearCache'))
              .wrapControl()
              .description(t('settings.data.clearCacheDesc'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      LButton(LText(t('common.open', { defaultValue: 'Open' })))
                        .size('sm')
                        .style('subtle')
                        .tint('danger')
                        .onPress(handleClearCache)
                        .label(t('settings.data.clearCache')),
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
