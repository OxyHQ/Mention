import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatMercariaRef } from '@mercaria.co/sdk';
import { connectPostgres, closePostgres } from '../../../db/postgres';
import { loadPostRecord, replacePostContent } from '../../../db/posts/postRepository';
import { seedPost, clearPostScope, postScope } from '../../helpers/postFixtures';
import { buildOrderedAttachments } from '../../../controllers/posts/composeInput';
import type { CommerceReference } from '@mention/shared-types/commerce';

const scope = postScope('commerce-persistence');
const refs: CommerceReference[] = [
  { kind: 'product', id: 'p-persist' },
  { kind: 'collection', id: 'c-persist' },
];
beforeAll(connectPostgres);
afterAll(async () => {
  await clearPostScope(scope);
  await closePostgres();
});

describe('commerce refs in normalized post content', () => {
  it('round-trips ordered refs through full reads, then removes them on edit', async () => {
    const attachments = refs
      .toReversed()
      .map((ref) => ({ type: 'commerce' as const, id: formatMercariaRef(ref) }));
    const post = await seedPost(scope, {
      content: { variants: [{ source: 'author', text: 'Stable references' }], attachments },
    });
    expect(post.content.commerce).toEqual(refs.toReversed());
    await replacePostContent(
      post.id,
      { variants: [{ source: 'author', text: 'Removed product' }], attachments: [] },
      [],
    );
    const edited = await loadPostRecord(post.id);
    expect(edited?.content.commerce).toEqual([]);
    expect(edited?.content.attachments).toBeUndefined();
  });
  it('cannot smuggle an unvalidated ref through raw attachment descriptors', () => {
    const attachments = buildOrderedAttachments({
      rawAttachments: [
        { type: 'commerce', id: formatMercariaRef({ kind: 'product', id: 'forged' }) },
        { type: 'commerce', id: formatMercariaRef(refs[1]) },
      ],
      media: [],
      commerceRefs: refs,
    });
    expect(attachments).toEqual([
      { type: 'commerce', id: formatMercariaRef(refs[1]) },
      { type: 'commerce', id: formatMercariaRef(refs[0]) },
    ]);
  });
});
