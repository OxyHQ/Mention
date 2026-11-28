// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useHapticsSettingRow } from '@oxy.so/bloom/preferences/haptics-setting-row';
import { useVideoAutoplaySettingRow } from '@oxy.so/bloom/preferences/video-autoplay-setting-row';
import { SettingsGeneralPage } from '@oxy.so/bloom/settings-modal';
import { useTranslation } from 'react-i18next';

/**
 * Accessibility: the viewer's preferences, which are Bloom's. Bloom owns their
 * state, persistence (with the theme) and text, and every component honours
 * them; this page only places the rows.
 */
export default function AccessibilitySettingsContent() {
  const { t } = useTranslation();
  const haptics = useHapticsSettingRow();
  const autoplay = useVideoAutoplaySettingRow();
  return (
    <SettingsGeneralPage
      sections={[
        { key: 'interaction', label: t('settings.accessibility.interaction'), rows: [haptics] },
        { key: 'media', label: t('settings.accessibility.media'), rows: [autoplay] },
      ]}
    />
  );
}
