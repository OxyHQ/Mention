// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { getI18n } from 'react-i18next';
import { appI18n, initializeI18n, setLanguage } from '../i18n';

jest.mock('@/utils/storage', () => ({ Storage: { get: jest.fn(async () => 'en-US') } }));
jest.mock('@oxy.so/core/logger', () => ({ logger: { error: jest.fn() } }));

describe('application language instance', () => {
  it('initializes and switches resource bundles on the same live instance', async () => {
    await Promise.all([setLanguage('es-ES'), initializeI18n('es-ES')]);
    expect(appI18n.language).toBe('es-ES');
    expect(appI18n.hasResourceBundle('en-US', 'translation')).toBe(true);
    expect(getI18n()).toBe(appI18n);
    appI18n.addResourceBundle('es-ES', 'translation', { greeting: 'Hola' });
    await setLanguage('es-ES');
    expect(appI18n.language).toBe('es-ES');
    expect(getI18n().t('greeting')).toBe('Hola');
    expect(appI18n.hasResourceBundle('es-ES', 'translation')).toBe(true);
    await setLanguage('en-US');
    expect(appI18n.language).toBe('en-US');
  });
});
