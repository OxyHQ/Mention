import { MeterRing } from '@oxy.so/bloom/stat-bar';
import { MAX_POST_TEXT_LENGTH } from '@mention/shared-types/post';
import { useTranslation } from 'react-i18next';

/** The actual publication limit, shared by compact and full composers. */
export function ComposeCharacterCount({
  count,
  max = MAX_POST_TEXT_LENGTH,
}: {
  count: number;
  max?: number;
}) {
  const { t } = useTranslation();
  return (
    <MeterRing
      value={count}
      max={max}
      size={20}
      thickness={2}
      accessibilityLabel={t('compose.characterCountLabel', { defaultValue: 'Characters' })}
      valueText={t('compose.characterCountValue', {
        count,
        max,
        defaultValue: '{{count}} of {{max}} characters',
      })}
    />
  );
}
