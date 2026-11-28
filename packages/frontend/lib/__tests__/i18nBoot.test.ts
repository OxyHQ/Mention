/** @jest-environment jsdom */
import { appI18n, setLanguage } from '../i18n';

jest.mock('@oxy.so/core/logger', () => ({ logger: { error: jest.fn() } }));

it('initializes the requested language once and still switches languages later', async () => {
  const changed = jest.fn();
  const changeLanguage = jest.spyOn(appI18n, 'changeLanguage');
  appI18n.on('languageChanged', changed);

  await setLanguage('en-US');

  expect(appI18n.language).toBe('en-US');
  expect(document.documentElement.lang).toBe('en-US');
  expect(changed.mock.calls).toEqual([['en-US']]);
  expect(changeLanguage).toHaveBeenCalledTimes(1);

  appI18n.addResourceBundle('es-ES', 'translation', { greeting: 'Hola' });
  await setLanguage('es-ES');

  expect(appI18n.language).toBe('es-ES');
  expect(document.documentElement.lang).toBe('es-ES');
  expect(appI18n.t('greeting')).toBe('Hola');
  expect(changed.mock.calls).toEqual([['en-US'], ['es-ES']]);
  expect(changeLanguage).toHaveBeenCalledTimes(2);
  appI18n.off('languageChanged', changed);
  changeLanguage.mockRestore();
});
