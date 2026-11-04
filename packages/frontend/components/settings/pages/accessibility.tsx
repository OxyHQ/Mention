import { useHapticsSettingRow, useVideoAutoplaySettingRow } from '@oxy.so/bloom/preferences';
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
