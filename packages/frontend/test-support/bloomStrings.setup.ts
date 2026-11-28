/**
 * Bloom's `String(localized:)` reads the catalogs `lib/i18n.ts` registers in the app. Unit
 * tests mock `react-i18next` (or never boot i18next), so nothing registers them: a `.bloom`
 * module would draw its keys where the TypeScript drew i18next's English. The English catalog
 * is registered here, as the app registers it, before each test file runs.
 */
import { toBloomCatalog } from '@/lib/bloomCatalog';
import { preferBloomLocale, registerBloomCatalog } from '@/lib/bloomLocalization.bloom';
import en from '@/locales/en.json';

registerBloomCatalog('en', toBloomCatalog(en));
preferBloomLocale('en-US');
