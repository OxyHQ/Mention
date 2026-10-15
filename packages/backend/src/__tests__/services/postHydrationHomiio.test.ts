import { describe, it, expect, vi } from 'vitest';
import type { PostAttachmentBundle, PostContent } from '@mention/shared-types';
import { resolveVariant } from '../../services/postVariants';

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getUserById: vi.fn() }),
}));

// The bulk service-token client used elsewhere in the service.
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUsersByIds: vi.fn() }),
}));

// Legacy-store models are not touched on the buildAttachments path; stub to empty objects.
vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async () => new Map()),
  mset: vi.fn(async () => undefined),
}));

import { PostHydrationService } from '../../services/PostHydrationService';

/** Precise structural view of the private method under test (no `as any`). */
interface AttachmentBuilder {
  buildAttachments(
    post: { content?: Partial<PostContent> },
    pollMap: Map<string, Record<string, unknown>>,
    resolved: ReturnType<typeof resolveVariant>,
  ): PostAttachmentBundle;
}

function asBuilder(service: PostHydrationService): AttachmentBuilder {
  return service as unknown as AttachmentBuilder;
}

/** Build the bundle the way hydration does: on the reader's resolved rendition. */
function buildBundle(service: PostHydrationService, content: PostContent): PostAttachmentBundle {
  return asBuilder(service).buildAttachments({ content }, new Map(), resolveVariant(content));
}

describe('Homiio hydration has no provider dependency', () => {
  it('emits only a reference even if the input carries private provider metadata', () => {
    const untrusted = { caseId: 'case-1', title: 'not ours', address: 'private address' };
    const bundle = buildBundle(new PostHydrationService(), { homiioCase: untrusted });
    expect(bundle.homiioCase).toEqual({ caseId: 'case-1' });
    expect(JSON.stringify(bundle)).not.toContain('private address');
  });
  it('can show older case links without Clarity fallback or a provider roundtrip', () => {
    const bundle = buildBundle(new PostHydrationService(), {
      variants: [{ tag: 'en', source: 'author', text: 'https://homiio.com/evictions/old-case' }],
    });
    expect(bundle.homiioCase).toEqual({ caseId: 'old-case' });
  });
});
