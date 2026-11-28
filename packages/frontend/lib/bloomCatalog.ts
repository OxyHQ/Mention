/**
 * An i18next translation as Bloom's catalog (ADR 0002, section 3): what `String(localized:)`
 * reads. `locales/*.json` stays the only source people edit. This one function makes both
 * copies of it: `scripts/bloom-catalogs.ts` writes `Resources/Localizable/<lang>.json`, which
 * bloomc checks keys against, and `lib/i18n.ts` registers what it loads at run time.
 *
 * - Nested keys are flattened: `{ post: { reply: "…" } }` is `"post.reply"`.
 * - `{{name}}` is `{name}`.
 * - `k_one`, `k_other` and the other CLDR categories are `k: { one, other, … }`. i18next's
 *   `k_zero` is kept as the `zero` form: i18next takes it for a count of exactly 0 in every
 *   language, not only where CLDR has a `zero` category.
 *
 * Mention's catalogs use no nesting (`$t(…)`), formats (`{{x, number}}`) or contexts, so they
 * have no Bloom form here, and `convert` refuses them rather than change what is drawn.
 */

export type BloomCatalog = Record<string, string | Record<string, string>>;

const PLURAL = /^(.*)_(zero|one|two|few|many|other)$/;

export function toBloomCatalog(translation: unknown): BloomCatalog {
  const flat: Record<string, string> = {};
  const walk = (node: unknown, prefix: string) => {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'string') flat[name] = value;
      else if (value && typeof value === 'object') walk(value, name);
      else throw new Error(`${name}: a catalog value is a string or an object`);
    }
  };
  walk(translation, '');

  const out: BloomCatalog = {};
  for (const [name, value] of Object.entries(flat)) {
    if (/\$t\(|\{\{[^}]*,/.test(value)) {
      throw new Error(`${name}: i18next nesting and formats have no Bloom form`);
    }
    const text = value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, '{$1}');
    const plural = PLURAL.exec(name);
    if (plural && !(name in out)) {
      const [, base, category] = plural;
      if (typeof out[base] === 'string' || (flat[base] !== undefined && base !== name)) {
        throw new Error(`${base}: both a string and plural forms`);
      }
      out[base] = { ...((out[base] as Record<string, string>) ?? {}), [category]: text };
    } else {
      out[name] = text;
    }
  }
  return out;
}

/** The catalog file of an i18next language: `es-ES` and `es` are `es`. */
export function catalogLocale(language: string): string {
  return language.split('-')[0] ?? language;
}
