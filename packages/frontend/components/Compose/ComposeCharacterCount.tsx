// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
