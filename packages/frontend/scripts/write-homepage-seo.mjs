import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const english = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Add crawler-visible homepage metadata to the single-page export, never its body. */
export function withHomepageSEO(html, env = process.env) {
  const origin = new URL(env.EXPO_PUBLIC_WEB_BASE_URL || 'https://mention.earth').origin;
  const name = env.EXPO_PUBLIC_INSTANCE_NAME || 'Mention';
  const title = english.seo.home.title.replaceAll('Mention', name);
  const description = english.seo.home.description.replaceAll('Mention', name);
  const url = `${origin}/`;
  const image = `${origin}/og-image.jpg`;
  const imageAlt = 'Illustration of friends and a dog gathered around the Mention logo under a blue sky.';
  const meta = (attribute, key, value) => `<meta data-mention-seo="true" ${attribute}="${key}" content="${escape(value)}" />`;
  const tags = [
    meta('name', 'description', description), meta('name', 'robots', 'index,follow'),
    ...Object.entries({ type: 'website', url, title, description, image, 'image:width': '1280', 'image:height': '720', 'image:type': 'image/jpeg', 'image:alt': imageAlt, site_name: name }).map(([key, value]) => meta('property', `og:${key}`, value)),
    ...Object.entries({ card: 'summary_large_image', url, title, description, image, 'image:alt': imageAlt }).map(([key, value]) => meta('name', `twitter:${key}`, value)),
    `<link data-mention-seo="true" data-mention-seo-default="true" rel="canonical" href="${escape(url)}" />`,
  ].join('\n');
  if (!/<title\b[^>]*>[\s\S]*?<\/title>/i.test(html) || !/<\/head>/i.test(html)) throw new Error('Export is missing its title or head');
  // Idempotent when a build is postprocessed again. Never match body tags.
  const end = html.search(/<\/head>/i);
  const head = html.slice(0, end).replace(/<(?:meta|link)\b[^>]*data-mention-seo="true"[^>]*>/gi, '')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, () => `<title data-mention-seo="true">${escape(title)}</title>`);
  return head + tags + '\n' + html.slice(end);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Match Expo export's dotenv precedence; its child process cannot export env back here.
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  const fromExpo = createRequire(import.meta.resolve('expo/package.json'));
  const fromCLI = createRequire(fromExpo.resolve('@expo/cli/package.json'));
  const expoEnv = fromCLI('@expo/env');
  expoEnv.setNodeEnv('production');
  expoEnv.load(projectRoot, { silent: true });
  const path = resolve(process.argv[2] || 'dist/index.html');
  writeFileSync(path, withHomepageSEO(readFileSync(path, 'utf8')));
}
