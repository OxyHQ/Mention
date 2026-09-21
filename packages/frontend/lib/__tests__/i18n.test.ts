import { getI18n } from 'react-i18next';
import { appI18n, initializeI18n, setLanguage } from '../i18n';

jest.mock('@/utils/storage', () => ({ Storage: { get: jest.fn(async () => 'en-US') } }));
jest.mock('@oxy.so/core/logger', () => ({ logger: { error: jest.fn() } }));

describe('application language instance', () => {
  it('initializes and switches resource bundles on the same live instance', async () => {
    await Promise.all([setLanguage('en-US'), initializeI18n()]);
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
