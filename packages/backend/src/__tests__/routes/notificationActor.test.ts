import { describe, it, expect, vi } from 'vitest';

/**
 * Contract test for the notification embedded-actor serializer.
 *
 * `toPopulatedActor` builds the `actorId_populated` DTO embedded on every
 * notification. Per the profile-identity contract it MUST emit a required,
 * non-blank `name.displayName` so clients render it directly with no
 * `displayName || username` recompute. The `|| id` floor is the never-blank
 * last resort (the handle), not a name recompute.
 */

// `notifications.ts` imports the app server at module load; stub it so the route
// module (and the pure serializer under test) can be imported in isolation.
vi.mock('../../../server', () => ({ oxy: {} }));
// `toPopulatedActor` resolves the avatar via the media resolver; keep it pure so
// the test exercises the name contract without touching the Oxy media client.
vi.mock('../../utils/mediaResolver', () => ({
  resolveAvatarUrl: (ref?: string | null) => (typeof ref === 'string' ? ref : undefined),
}));

import { toPopulatedActor } from '../../routes/notifications';

describe('notifications: toPopulatedActor embedded-actor DTO', () => {
  it('emits the canonical required name.displayName from a resolved Oxy user', () => {
    const dto = toPopulatedActor(
      {
        id: 'oxy-actor-1',
        username: 'jane',
        name: { displayName: 'Jane Doe' },
        avatar: 'https://cdn.example/jane.png',
      },
      'fallback-id',
    );

    expect(dto.name).toEqual({ displayName: 'Jane Doe' });
    expect(dto.name.displayName).toBe('Jane Doe');
    expect(dto._id).toBe('oxy-actor-1');
    expect(dto.username).toBe('jane');
    // No flat `displayName` field — the canonical contract is `name.displayName`.
    expect((dto as Record<string, unknown>).displayName).toBeUndefined();
  });

  it('falls back to the id (never blank) when displayName is missing/blank', () => {
    const dto = toPopulatedActor(
      { id: 'oxy-actor-2', username: 'bob', name: { displayName: '   ' } },
      'fallback-id',
    );
    expect(dto.name.displayName).toBe('oxy-actor-2');
    expect(dto.name.displayName.length).toBeGreaterThan(0);
  });

  it('uses the fallback id when the actor has no id at all', () => {
    const dto = toPopulatedActor(
      { username: 'sys', name: { displayName: 'System' } },
      'system',
    );
    expect(dto._id).toBe('system');
    expect(dto.name.displayName).toBe('System');
  });
});
