// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import en from '@/locales/en.json';

/**
 * The English catalog text for a dotted key, as i18next resolves it from the
 * nested catalog (ADR 0055), with `{{name}}` placeholders filled from `values`.
 * A key with `count` reads its `_one` / `_other` form. A missing key returns the
 * key itself and ignores `defaultValue`, so a test fails when its key is gone.
 */
export function catalogText(key: string, values: Record<string, unknown> = {}): string {
  const lookup = (path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
        en,
      );
  const count = values.count;
  const plural =
    typeof count === 'number' ? lookup(`${key}_${count === 1 ? 'one' : 'other'}`) : undefined;
  const text = plural ?? lookup(key);
  if (typeof text !== 'string') return key;
  return text.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

/** A `react-i18next` mock whose `t` reads the real English catalog. */
export function catalogTranslationMock() {
  const t = (key: string, values?: Record<string, unknown>) => catalogText(key, values);
  return {
    useTranslation: () => ({ t, i18n: { language: 'en' } }),
    Trans: ({ i18nKey }: { i18nKey: string }) => catalogText(i18nKey),
  };
}
