// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useScreenBack } from '@oxy.so/bloom/screen';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/common/EmptyState';

export interface ProfileUnavailableProps {
  /**
   * The lookup answered that there is no such account (`useProfileData`'s
   * `notFound`). Otherwise the lookup FAILED, and the reader is offered a retry
   * rather than told a real account does not exist.
   */
  notFound: boolean;
  onRetry: () => Promise<void>;
  /** What the missing account means on this screen, under "Profile not found". */
  notFoundMessage?: string;
}

/**
 * The one "this profile cannot be shown" state, for every screen that looks an
 * account up by handle — the profile, a channel, its connections, its account
 * info. Each used to draw its own "Profile not found", and said it for any
 * failure, a dropped connection included (OxyHQ/Mention#1124).
 */
export function ProfileUnavailable({
  notFound,
  onRetry,
  notFoundMessage,
}: ProfileUnavailableProps) {
  const { t } = useTranslation();
  const back = useScreenBack();

  if (!notFound) {
    return (
      <EmptyState
        error={{
          title: t('common.error', { defaultValue: 'Something went wrong' }),
          message: t('profile.loadFailed', {
            defaultValue: "This profile couldn't be loaded. Check your connection and try again.",
          }),
          onRetry,
        }}
        sticker="offline"
        containerStyle={{ paddingTop: 60 }}
      />
    );
  }

  return (
    <EmptyState
      sticker="profileNotFound"
      title={t('profile.notFound.title', { defaultValue: 'Profile not found' })}
      subtitle={
        notFoundMessage ??
        t('profile.notFound.gone', {
          defaultValue: "This account doesn't exist, or it's no longer available.",
        })
      }
      action={{ label: t('common.goBack', { defaultValue: 'Go Back' }), onPress: () => back?.() }}
    />
  );
}
