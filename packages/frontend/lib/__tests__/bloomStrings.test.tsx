import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInstance, type i18n as I18n } from 'i18next';
import TestRenderer, { act } from 'react-test-renderer';
import { toElement } from '@oxy.so/bloom-language';

import { toBloomCatalog } from '@/lib/bloomCatalog';
import { preferBloomLocale, registerBloomCatalog } from '@/lib/bloomLocalization.bloom';
import { appI18n, initializeI18n, setLanguage } from '@/lib/i18n';
import { bloomString, LoadingLabel } from './bloomStrings.bloom';

/**
 * Bloom's `String(localized:)` and i18next's `t()` draw the same text from Mention's catalogs
 * while both are in use (the port's transition): every key of every locale, its `{{x}}`
 * placeholders, and its plural forms over counts that reach every CLDR category the locales
 * use (Arabic's `zero`, `two`, `few` and `many`, Russian's `few` and `many`, the Romance
 * languages' `many`). The generated `Resources/Localizable` is what `locales/` gives.
 */

const LOCALES = join(__dirname, '..', '..', 'locales');
const FILES = readdirSync(LOCALES)
  .filter((f) => f.endsWith('.json'))
  .sort();
const COUNTS = [0, 1, 2, 3, 5, 11, 21, 100, 101, 1000000, 1.5];
const PLURAL = /^(.*)_(zero|one|two|few|many|other)$/;

function flatten(node: unknown, prefix = '', out: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[name] = value;
    else flatten(value, name, out);
  }
  return out;
}

/** Each placeholder `{{x}}` given the value `<x>`, for both sides. */
function argsOf(text: string): Record<string, string> {
  const args: Record<string, string> = {};
  for (const [, name] of text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    if (name !== 'count') args[name] = `<${name}>`;
  }
  return args;
}

async function i18nextFor(file: string, translation: unknown): Promise<I18n> {
  const instance = createInstance();
  const language = file.replace(/\.json$/, '');
  await instance.init({
    resources: { [language]: { translation } as never },
    lng: language,
    fallbackLng: false,
    interpolation: { escapeValue: false },
  });
  return instance;
}

describe.each(FILES)('%s', (file) => {
  const translation = JSON.parse(readFileSync(join(LOCALES, file), 'utf8'));
  const language = file.replace(/\.json$/, '');
  const flat = flatten(translation);
  const plurals = new Map<string, string[]>();
  for (const key of Object.keys(flat)) {
    const plural = PLURAL.exec(key);
    if (plural) plurals.set(plural[1], [...(plurals.get(plural[1]) ?? []), key]);
  }
  let t: I18n['t'];

  beforeAll(async () => {
    t = (await i18nextFor(file, translation)).t;
    registerBloomCatalog(language, toBloomCatalog(translation));
    preferBloomLocale(language);
  });

  it('draws every string as i18next does', () => {
    const differ: string[] = [];
    for (const [key, text] of Object.entries(flat)) {
      if (PLURAL.test(key)) continue;
      const args = argsOf(text);
      // A `{{count}}` outside plural forms is the count as given.
      const count = /\{\{\s*count\s*\}\}/.test(text) ? 7 : undefined;
      const want = String(t(key, (count === undefined ? args : { ...args, count }) as never));
      const got = bloomString(key, args, count);
      if (got !== want)
        differ.push(`${key}: i18next ${JSON.stringify(want)}, Bloom ${JSON.stringify(got)}`);
    }
    expect(differ).toEqual([]);
  });

  it('chooses the plural form i18next does, for a count other than 0', () => {
    const differ: string[] = [];
    for (const [base, keys] of plurals) {
      const args = argsOf(keys.map((k) => flat[k]).join(' '));
      for (const count of COUNTS.filter((c) => c !== 0)) {
        const want = t(base, { ...args, count });
        const got = bloomString(base, args, count);
        if (got !== want)
          differ.push(
            `${base} (${count}): i18next ${JSON.stringify(want)}, Bloom ${JSON.stringify(got)}`,
          );
      }
    }
    expect(differ).toEqual([]);
  });

  // i18next takes `k_zero` for a count of exactly 0 in every language; Bloom's runtime takes
  // the CLDR category (`other` for 0 in English), so `k_zero` is only used where CLDR has
  // `zero` (Arabic). Asked of the compiler owner; this fails, as it should, until it is fixed.
  const zeroDiffers = [...plurals.values()].some((keys) => keys.some((k) => k.endsWith('_zero')));
  (zeroDiffers && language !== 'ar' ? it.failing : it)(
    'chooses i18next’s form for a count of 0',
    () => {
      const differ: string[] = [];
      for (const [base, keys] of plurals) {
        const args = argsOf(keys.map((k) => flat[k]).join(' '));
        const want = t(base, { ...args, count: 0 });
        const got = bloomString(base, args, 0);
        if (got !== want)
          differ.push(`${base}: i18next ${JSON.stringify(want)}, Bloom ${JSON.stringify(got)}`);
      }
      expect(differ).toEqual([]);
    },
  );
});

describe('Resources/Localizable', () => {
  it('is what locales/ gives', () => {
    const generated = join(__dirname, '..', '..', 'Resources', 'Localizable');
    for (const file of FILES) {
      const translation = JSON.parse(readFileSync(join(LOCALES, file), 'utf8'));
      const want = `${JSON.stringify(toBloomCatalog(translation), null, 2)}\n`;
      expect(readFileSync(join(generated, file), 'utf8')).toBe(want);
    }
  });
});

describe('the app language', () => {
  beforeAll(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initializeI18n('en-US');
    // What `setLanguage`'s loader adds (Jest's vm has no `import()`, as in i18n.test.ts).
    appI18n.addResourceBundle(
      'es-ES',
      'translation',
      JSON.parse(readFileSync(join(LOCALES, 'es.json'), 'utf8')),
    );
  });

  it('registers each catalog the app loads and follows a switch', async () => {
    expect(bloomString('podcast.loading', {}, undefined)).toBe(appI18n.t('podcast.loading'));
    await setLanguage('es-ES');
    expect(appI18n.t('podcast.loading')).not.toBe('Loading podcast…');
    expect(bloomString('podcast.loading', {}, undefined)).toBe(appI18n.t('podcast.loading'));
    await setLanguage('en-US');
  });

  // bloomc memoizes `String(localized:)` as a constant (a sentinel cache slot), and nothing
  // tells a drawn view that the locale changed, so a mounted label keeps the old language.
  // Asked of the compiler owner; this fails, as it should, until it is fixed.
  it.failing('re-draws a mounted label when the language switches, without a remount', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(toElement(LoadingLabel()));
    });
    const before = JSON.stringify(renderer.toJSON());
    await act(async () => {
      await setLanguage('es-ES');
    });
    const after = JSON.stringify(renderer.toJSON());
    await setLanguage('en-US');
    expect(after).not.toBe(before);
  });
});
