import { describe, it, expect, vi } from 'vitest';

/**
 * Contract test for the notification embedded-actor serializer.
 *
 * `toPopulatedActor` builds the `actorId_populated` DTO embedded on every
 * notification. Per the profile-identity contract it MUST emit a required,
 * non-blank `name.displayName` so clients render it directly with no
 * `displayName || username` recompute. Unresolved actors use the canonical
 * neutral placeholder and never copy an Oxy id into visual identity fields.
 */

// `notifications.ts` imports the app server at module load; stub it so the route
// module (and the pure serializer under test) can be imported in isolation.
vi.mock('../../runtime/oxyClient', () => ({ getRuntimeOxyClient: () => ({}) }));
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

  it('falls back to the real username when displayName is missing/blank', () => {
    const dto = toPopulatedActor(
      { id: 'oxy-actor-2', username: 'bob', name: { displayName: '   ' } },
      'fallback-id',
    );
    expect(dto.username).toBe('bob');
    expect(dto.name.displayName).toBe('bob');
  });

  it('uses the fallback id when the actor has no id at all', () => {
    const dto = toPopulatedActor(
      { username: 'sys', name: { displayName: 'System' } },
      'system',
    );
    expect(dto._id).toBe('system');
    expect(dto.name.displayName).toBe('System');
  });

  it('uses the neutral degraded identity when Oxy returns only its raw id', () => {
    const dto = toPopulatedActor(
      {
        id: 'oxy-actor-3',
        username: 'oxy-actor-3',
        name: { displayName: 'oxy-actor-3' },
      },
      'oxy-actor-3',
    );

    expect(dto._id).toBe('oxy-actor-3');
    expect(dto.username).toBe('');
    expect(dto.name.displayName).toBe('Unknown user');
  });

  it('uses the neutral degraded identity when actor resolution misses', () => {
    const dto = toPopulatedActor(undefined, 'oxy-missing-actor');

    expect(dto._id).toBe('oxy-missing-actor');
    expect(dto.username).toBe('');
    expect(dto.name.displayName).toBe('Unknown user');
  });
});
