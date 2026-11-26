import { describe, it, expect, vi } from 'vitest';
import type { PostAttachmentBundle, PostContent } from '@mention/shared-types';
import { resolveVariant } from '../../services/posts/postVariants';

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ getUserById: vi.fn() }),
}));

// The bulk service-token client used elsewhere in the service.
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUsersByIds: vi.fn() }),
}));

// Legacy-store models are not touched on the buildAttachments path; stub to empty objects.
vi.mock('../../services/accounts/userSummaryCache', () => ({
  mget: vi.fn(async () => new Map()),
  mset: vi.fn(async () => undefined),
}));

import { buildAttachments } from '../../services/posts/postHydration/dto';

/** Build the bundle the way hydration does: on the reader's resolved rendition. */
function buildBundle(content: PostContent): PostAttachmentBundle {
  return buildAttachments({ content }, new Map(), resolveVariant(content));
}

describe('Homiio hydration has no provider dependency', () => {
  it('emits only a reference even if the input carries private provider metadata', () => {
    const untrusted = { caseId: 'case-1', title: 'not ours', address: 'private address' };
    const bundle = buildBundle({ homiioCase: untrusted });
    expect(bundle.homiioCase).toEqual({ caseId: 'case-1' });
    expect(JSON.stringify(bundle)).not.toContain('private address');
  });
  it('can show older case links without Clarity fallback or a provider roundtrip', () => {
    const bundle = buildBundle({
      variants: [{ tag: 'en', source: 'author', text: 'https://homiio.com/evictions/old-case' }],
    });
    expect(bundle.homiioCase).toEqual({ caseId: 'old-case' });
  });
});

describe('Vibbr hydration carries only the event id', () => {
  const eventId = `evt_${'a'.repeat(24)}`;
  it('emits only the id even if the input carries event facts', () => {
    const untrusted = { eventId, title: 'not ours', venue: 'private venue' };
    const bundle = buildBundle({ vibbrEvent: untrusted });
    expect(bundle.vibbrEvent).toEqual({ eventId });
    expect(JSON.stringify(bundle)).not.toContain('private venue');
  });
  it('finds the event in a pasted canonical link and ignores a look-alike host', () => {
    const link = (text: string) =>
      buildBundle({
        variants: [{ tag: 'en', source: 'author', text }],
      }).vibbrEvent;
    expect(link(`Tickets https://vibbr.co/e/${eventId}`)).toEqual({ eventId });
    expect(link(`https://vibbr.co.evil.test/e/${eventId}`)).toBeUndefined();
  });
});
