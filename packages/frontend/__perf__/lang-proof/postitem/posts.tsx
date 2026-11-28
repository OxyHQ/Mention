/**
 * DEV ONLY: PostItem in its two forms, for the PostItem proof (`../README.md`, "PostItem"):
 *
 * - `ts`: `variants/PostItem.tsx`, the TypeScript `bloom migrate` replaced, drawn as the
 *   TS feed drew it (`<PostItem … />`);
 * - `bloom`: `components/Feed/PostItem.bloom`, drawn as the feed draws it now
 *   (`toElement(PostItem({ … }))`).
 *
 * Each post is a fixture of the feed row-cost harness (`components/Feed/__perf__/fixtures.ts`),
 * with the props `renderFeedRow` gives a plain feed row.
 */
import { toElement } from '@oxy.so/bloom-language';
import { createElement, type ReactElement } from 'react';

import { PostItem as BloomPostItem } from '@/components/Feed/PostItem.bloom';
import { ROW_KINDS, makeRow, type RowKind } from '@/components/Feed/__perf__/fixtures';
import TsPostItem from './variants/PostItem';

export type PostForm = 'ts' | 'bloom';
export const POST_FORMS: PostForm[] = ['ts', 'bloom'];
export const POST_KINDS: readonly RowKind[] = ROW_KINDS;

export function proofPost(kind: RowKind) {
  return makeRow(kind, `proof-${kind}`);
}

/** The props `renderFeedRow` gives a plain (unthreaded, unsliced) row. */
function rowProps(item: ReturnType<typeof proofPost>) {
  // A pure repost draws its original with the booster above it, as `renderFeedRow` does.
  const boost = (item as { boost?: { originalPost?: typeof item | null; actor?: unknown } }).boost;
  const post = boost?.originalPost ?? item;
  return {
    post,
    repostedBy: boost?.originalPost ? boost.actor : undefined,
    isThreadParent: false,
    isThreadChild: false,
    isThreadLastChild: false,
    attachedBelow: false,
    replyBranch: false,
    hideSeparator: false,
    nestingDepth: 0,
    feedDescriptor: 'proof',
    sliceKey: item.id,
    isThread: false,
    openPostEngagement: null,
  };
}

export function drawPost(form: PostForm, post: ReturnType<typeof proofPost>): ReactElement {
  const props = rowProps(post);
  return form === 'bloom'
    ? toElement(BloomPostItem(props as never))
    : createElement(TsPostItem as never, props as never);
}
