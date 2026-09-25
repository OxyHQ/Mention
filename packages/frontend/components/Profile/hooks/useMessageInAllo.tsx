import React, { useCallback } from 'react';
import { Linking, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { logger } from '@oxy.so/core/logger';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiDownloadLine } from '@oxy.so/bloom/icons/RiDownloadLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';

import { showActionMenu } from '@/components/common/ActionMenu';
import { getAlloStoreUrl, openAlloDirectMessage } from '@/lib/alloDirectMessage';
import { openExternalLink } from '@/utils/openExternalLink';

/**
 * The profile's "Message @handle in Allo" action: a direct conversation with
 * this account in Allo, Oxy's messaging app. The decisions (which URL, what to
 * do without the app) live in `lib/alloDirectMessage.ts`; this binds them to
 * `Linking`, the browser and the app's action menu.
 *
 * `oxyUserId` is the account's Oxy id, which is what Allo's `/c/:id` takes.
 */
export function useMessageInAllo(
  oxyUserId: string | undefined,
  handle: string,
): () => void {
  const { t } = useTranslation();
  const theme = useTheme();

  return useCallback(() => {
    openAlloDirectMessage(oxyUserId, {
      platformOS: Platform.OS,
      openAppUrl: (url) => Linking.openURL(url),
      openWebUrl: (url) => openExternalLink(url),
      storeUrl: getAlloStoreUrl(Platform.OS),
      offerInstall: ({ storeUrl, webUrl }) =>
        showActionMenu({
          label: t('profile.allo.notInstalled', {
            handle,
            defaultValue: 'Allo is not installed. Get Allo to message @{{handle}}, or continue on the web.',
          }),
          groups: [
            [
              {
                label: t('profile.allo.getApp', { defaultValue: 'Get Allo' }),
                icon: <RiDownloadLine size="lg" fill={theme.colors.text} />,
                onPress: () => {
                  Linking.openURL(storeUrl).catch((error: unknown) =>
                    logger.warn('Could not open the Allo store listing', { error }),
                  );
                },
              },
              {
                label: t('profile.allo.openWeb', { defaultValue: 'Open Allo on the web' }),
                icon: <RiGlobalLine size="lg" fill={theme.colors.text} />,
                onPress: () => {
                  void openExternalLink(webUrl);
                },
              },
            ],
          ],
        }),
    }).catch((error: unknown) => logger.warn('Could not open Allo', { error }));
  }, [oxyUserId, handle, t, theme.colors.text]);
}
