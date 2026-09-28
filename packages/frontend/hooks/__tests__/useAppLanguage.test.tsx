import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * A real, UNINITIALISED i18next instance stands in for `lib/i18n`: the root
 * layout reads the language before `initializeI18n()` has run, and the
 * property under test is that it still hears the first language and every
 * switch after it.
 */
jest.mock('@/lib/i18n', () => {
  const { createInstance } = jest.requireActual<typeof import('i18next')>('i18next');
  return { __esModule: true, default: createInstance() };
});

import i18n from '@/lib/i18n';
import { useAppLanguage } from '../useAppLanguage';

describe('useAppLanguage', () => {
  it('is undefined before init, then follows init and every switch', async () => {
    const seen: (string | undefined)[] = [];
    function Probe() {
      seen.push(useAppLanguage());
      return null;
    }

    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(<Probe />);
    });
    expect(seen.at(-1)).toBeUndefined();

    await act(async () => {
      await i18n.init({ lng: 'es', resources: { es: { translation: {} }, de: { translation: {} } } });
    });
    expect(seen.at(-1)).toBe('es');

    await act(async () => {
      await i18n.changeLanguage('de');
    });
    expect(seen.at(-1)).toBe('de');

    act(() => tree?.unmount());
    // Unsubscribed: a switch after unmount must not throw or re-render.
    const renders = seen.length;
    await act(async () => {
      await i18n.changeLanguage('es');
    });
    expect(seen).toHaveLength(renders);
  });
});
