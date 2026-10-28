import { formatMercariaRef } from '@mercaria.co/sdk';
import type { PostContent } from '@mention/shared-types/post';
import type { CommerceReference } from '@mention/shared-types/commerce';
import { mapWithConcurrency } from '../../utils/concurrency';
import { config } from '../../config';
import { commerceReferencesFromAttachments } from '../../utils/commerceReferences';
import { getMercariaClient } from './mercariaClient';
import { resolveMercariaCollection } from './mercariaHydration';

/** Ordinary links for peers without commerce cards. No catalog facts enter the signed post. */
export async function commerceLinksByPost(
  posts: readonly { id: string; content: PostContent }[],
): Promise<Map<string, string[]>> {
  const refsByPost = new Map(
    posts.map((post) => [
      post.id,
      post.content.commerce ?? commerceReferencesFromAttachments(post.content.attachments ?? []),
    ]),
  );
  const unique = new Map<string, CommerceReference>();
  for (const refs of refsByPost.values())
    for (const ref of refs) unique.set(formatMercariaRef(ref), ref);
  const entries = [...unique.entries()];
  const outcomes = await mapWithConcurrency(
    entries,
    config.mercaria.hydrationConcurrency,
    async ([, ref]) => {
      if (ref.kind === 'product') return getMercariaClient().links.product(ref);
      const result = await resolveMercariaCollection(ref);
      return result.state === 'available' ? result.url : undefined;
    },
  );
  const urls = new Map<string, string>();
  entries.forEach(([key], index) => {
    const outcome = outcomes[index];
    if (outcome.status === 'fulfilled' && outcome.value) urls.set(key, outcome.value);
  });
  return new Map(
    [...refsByPost].map(([id, refs]) => [
      id,
      refs.flatMap((ref) => {
        const url = urls.get(formatMercariaRef(ref));
        return url ? [url] : [];
      }),
    ]),
  );
}
