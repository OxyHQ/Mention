import { describe, expect, it, vi } from 'vitest';
vi.mock('../../utils/oxyHelpers', () => ({ getServiceOxyClient: vi.fn() }));
import { formatPushForNotification } from '../../utils/push';

describe('out-of-band notification privacy', () => {
  it.each(['post', 'reply', 'mention', 'quote', 'boost'])(
    'keeps %s body text behind the authenticated read',
    async (type) => {
      const push = await formatPushForNotification(
        { id: 'notice', type, entityId: 'post', entityType: 'post', actorId: 'author' },
        { actor: async () => ({ name: { displayName: 'Ada' } }) },
      );
      expect(push.data).not.toHaveProperty('preview');
      expect(push.body).not.toContain('undefined');
      expect(push.body).toMatch(/^Ada /);
    },
  );
});
