import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withHomepageSEO } from './write-homepage-seo.mjs';

const shell = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
test('homepage head has the actual JPEG, one canonical and leaves body untouched', () => {
  const result = withHomepageSEO(shell, {});
  assert.equal(result.slice(result.indexOf('<body>')), shell.slice(shell.indexOf('<body>')));
  assert.match(result, /property="og:image" content="https:\/\/mention.earth\/og-image.jpg"/);
  assert.match(result, /property="og:image:width" content="1280"/);
  assert.match(result, /property="og:image:height" content="720"/);
  assert.match(result, /property="og:image:type" content="image\/jpeg"/);
  assert.match(result, /property="og:image:alt" content="Illustration of friends and a dog/);
  assert.match(result, /name="twitter:image:alt" content="Illustration of friends and a dog/);
  assert.match(result, /name="twitter:card" content="summary_large_image"/);
  assert.equal((withHomepageSEO(result, {}).match(/rel="canonical"/g) || []).length, 1);
  const image = readFileSync(new URL('../public/og-image.jpg', import.meta.url));
  assert.deepEqual([...image.subarray(0, 3)], [255, 216, 255]);
  assert.equal(image.length, 218236);
  assert.equal(createHash('sha256').update(image).digest('hex'), 'dd40609c5f18f558fd6ff4f50667bbc8eb7315fe6c6119f082de3c1a2720aaed');
});
test('instance origin and escaped brand are applied without touching body', () => {
  const result = withHomepageSEO(shell, { EXPO_PUBLIC_WEB_BASE_URL: 'https://social.example/', EXPO_PUBLIC_INSTANCE_NAME: 'People & <Friends>' });
  assert.match(result, /href="https:\/\/social.example\/"/);
  assert.match(result, /People &amp; &lt;Friends&gt;/);
  assert.doesNotMatch(result, /https:\/\/mention.earth\/og-image/);
  assert.throws(() => withHomepageSEO('<body>missing head</body>', {}));
});
