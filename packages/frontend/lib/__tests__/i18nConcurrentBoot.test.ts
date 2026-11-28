// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/** @jest-environment jsdom */
import { appI18n, initializeI18n, setLanguage } from '../i18n';

jest.mock('@oxy.so/core/logger', () => ({ logger: { error: jest.fn() } }));

it('honors a different language requested while initialization is pending', async () => {
  const changed = jest.fn();
  appI18n.on('languageChanged', changed);
  const initialize = initializeI18n('en-US');
  expect(appI18n.isInitialized).not.toBe(true);
  const change = setLanguage('xx-XX');

  await Promise.all([initialize, change]);

  expect(appI18n.language).toBe('xx-XX');
  expect(appI18n.resolvedLanguage).toBe('en-US');
  expect(document.documentElement.lang).toBe('en-US');
  expect(changed.mock.calls).toEqual([['en-US'], ['xx-XX']]);
  appI18n.off('languageChanged', changed);
});
