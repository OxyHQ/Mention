import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import type { DatePickerLabels } from '@oxy.so/bloom/date-picker';

import en from '@/locales/en.json';
import es from '@/locales/es.json';
import { useDatePickerLabels } from '../useDatePickerLabels';

/**
 * Runs against a REAL i18next instance over the shipped catalogs, so a key
 * missing from a catalog shows up as the English default rather than being
 * masked by a `t` mock that echoes whatever it is given.
 */
async function renderLabels(language: string) {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    resources: { en: { translation: en }, es: { translation: es } },
    keySeparator: false,
    interpolation: { escapeValue: false },
  });

  const seen: { labels: DatePickerLabels | null } = { labels: null };
  function Probe() {
    seen.labels = useDatePickerLabels();
    return null;
  }

  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <I18nextProvider i18n={i18n}>
        <Probe />
      </I18nextProvider>,
    );
  });
  return { i18n, seen, unmount: () => act(() => tree?.unmount()) };
}

describe('useDatePickerLabels', () => {
  it('names the footer and chevrons in English', async () => {
    const { seen, unmount } = await renderLabels('en');
    expect(seen.labels).toEqual({
      cancel: 'Cancel',
      apply: 'Apply',
      previousMonth: 'Previous month',
      nextMonth: 'Next month',
    });
    unmount();
  });

  it("follows the reader's language, including a switch after mount", async () => {
    const { i18n, seen, unmount } = await renderLabels('es');
    expect(seen.labels).toEqual({
      cancel: 'Cancelar',
      apply: 'Aplicar',
      previousMonth: 'Mes anterior',
      nextMonth: 'Mes siguiente',
    });

    await act(async () => {
      await i18n.changeLanguage('en');
    });
    expect(seen.labels?.apply).toBe('Apply');
    unmount();
  });
});
