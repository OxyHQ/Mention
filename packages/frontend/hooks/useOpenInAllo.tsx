import { useCallback } from 'react';
import { Linking, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { logger } from '@oxy.so/core/logger';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiDownloadLine } from '@oxy.so/bloom/icons/RiDownloadLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';

import { alloStoreUrl, openInAllo, type AlloLinks } from '@oxy.so/allo-sdk/links';

import { showActionMenu } from '@/components/common/ActionMenu';
import { ALLO_APP_STORE_URL, ALLO_PLAY_STORE_URL } from '@/config';
import { openExternalLink } from '@/utils/openExternalLink';

/**
 * Opens a place in Allo, Oxy's messaging app: the profile's "Message @handle"
 * and a post's "Send in Allo". The decisions (which URL, what to do without the
 * app) are Allo's own (`@oxy.so/allo-sdk/links`); this binds them to `Linking`,
 * the browser, the app's action menu and Mention's store-listing config.
 *
 * `notInstalledLabel` heads the "Get Allo / continue on the web" offer, so it
 * can say what the reader was trying to do.
 */
export function useOpenInAllo(): (links: AlloLinks | null, notInstalledLabel: string) => void {
  const { t } = useTranslation();
  const theme = useTheme();

  return useCallback(
    (links, notInstalledLabel) => {
      openInAllo(links, {
        platformOS: Platform.OS,
        openAppUrl: (url) => Linking.openURL(url),
        openWebUrl: (url) => openExternalLink(url),
        storeUrl: alloStoreUrl(Platform.OS, {
          ios: ALLO_APP_STORE_URL,
          android: ALLO_PLAY_STORE_URL,
        }),
        offerInstall: ({ storeUrl, webUrl }) =>
          showActionMenu({
            label: notInstalledLabel,
            groups: [
              [
                {
                  label: t('allo.getApp', { defaultValue: 'Get Allo' }),
                  icon: <RiDownloadLine size="lg" fill={theme.colors.text} />,
                  onPress: () => {
                    Linking.openURL(storeUrl).catch((error: unknown) =>
                      logger.warn('Could not open the Allo store listing', { error }),
                    );
                  },
                },
                {
                  label: t('allo.openWeb', { defaultValue: 'Open Allo on the web' }),
                  icon: <RiGlobalLine size="lg" fill={theme.colors.text} />,
                  onPress: () => {
                    void openExternalLink(webUrl);
                  },
                },
              ],
            ],
          }),
      }).catch((error: unknown) => logger.warn('Could not open Allo', { error }));
    },
    [t, theme.colors.text],
  );
}
