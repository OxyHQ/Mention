import { describe, expect, it } from 'vitest';
import { Lane, normalizeLaneName } from '../../models/Lane';
import { LaneMute } from '../../models/LaneMute';
import { MAX_LANE_NAME_LENGTH } from '@mention/shared-types';

/**
 * The two Lanes models, validated WITHOUT a database (documents are built and
 * `validateSync`'d, which is where every schema rule lives).
 *
 * What matters here is the pair of things a schema can get silently wrong: a
 * derived field that a caller could set to something else, and an index whose
 * declaration disagrees with the migration that actually creates it.
 */

describe('normalizeLaneName', () => {
  it('trims, collapses inner whitespace and lowercases', () => {
    expect(normalizeLaneName('  Notas   de   Nate  ')).toBe('notas de nate');
  });

  it('collapses to empty for a whitespace-only name', () => {
    expect(normalizeLaneName('   ')).toBe('');
  });

  it('makes two spellings of one name collide, which is what the unique index needs', () => {
    expect(normalizeLaneName('Dev')).toBe(normalizeLaneName('  dev '));
  });
});

describe('Lane model', () => {
  it('derives nameLower from name rather than trusting a caller', async () => {
    // A caller supplying its own `nameLower` is exactly how two spellings end up
    // both satisfying the unique index. The hook always wins.
    //
    // `validate()`, not `validateSync()`: `pre('validate')` middleware is async
    // and the sync form skips it entirely — which is also why every other test
    // here builds a document that would be valid without the hook.
    const lane = new Lane({
      ownerType: 'user',
      ownerId: 'u1',
      name: '  Fotos  De  Viaje ',
      nameLower: 'anything-else',
    });
    await lane.validate();
    expect(lane.nameLower).toBe('fotos de viaje');
  });

  it('defaults displayMode to mixed — a new lane behaves like no lane at all', () => {
    const lane = new Lane({ ownerType: 'user', ownerId: 'u1', name: 'Dev' });
    expect(lane.displayMode).toBe('mixed');
  });

  it('rejects an owner type outside the enum', () => {
    const lane = new Lane({ ownerType: 'group', ownerId: 'u1', name: 'Dev' });
    expect(lane.validateSync()?.errors.ownerType).toBeDefined();
  });

  it('rejects a display mode outside the enum', () => {
    const lane = new Lane({ ownerType: 'user', ownerId: 'u1', name: 'Dev', displayMode: 'secret' });
    expect(lane.validateSync()?.errors.displayMode).toBeDefined();
  });

  it('requires an owner and a name', () => {
    const errors = new Lane({}).validateSync()?.errors ?? {};
    expect(errors.ownerType).toBeDefined();
    expect(errors.ownerId).toBeDefined();
    expect(errors.name).toBeDefined();
  });

  it('enforces the shared name-length cap, so the API and the model agree', () => {
    const lane = new Lane({
      ownerType: 'user',
      ownerId: 'u1',
      name: 'x'.repeat(MAX_LANE_NAME_LENGTH + 1),
    });
    expect(lane.validateSync()?.errors.name).toBeDefined();
  });

  it('declares the three indexes migration 0022 creates, with the same uniqueness', () => {
    const declared = Lane.schema.indexes().map(([key, options]) => ({ key, unique: options?.unique }));
    expect(declared).toEqual([
      { key: { ownerType: 1, ownerId: 1, createdAt: -1 }, unique: undefined },
      { key: { ownerType: 1, ownerId: 1, nameLower: 1 }, unique: true },
      { key: { ownerType: 1, ownerId: 1, displayMode: 1 }, unique: undefined },
    ]);
  });
});

describe('LaneMute model', () => {
  it('requires the reader, the lane, and the denormalized owner', () => {
    const errors = new LaneMute({}).validateSync()?.errors ?? {};
    expect(errors.viewerOxyUserId).toBeDefined();
    expect(errors.laneId).toBeDefined();
    // Denormalized ON PURPOSE: the settings screen groups a reader's mutes by
    // publisher with no join. Optional, it would be absent exactly where it is
    // needed.
    expect(errors.laneOwnerOxyUserId).toBeDefined();
  });

  it('declares the two indexes migration 0022 creates, with the same uniqueness', () => {
    const declared = LaneMute.schema.indexes().map(([key, options]) => ({ key, unique: options?.unique }));
    expect(declared).toEqual([
      { key: { viewerOxyUserId: 1, laneId: 1 }, unique: true },
      { key: { viewerOxyUserId: 1, createdAt: -1 }, unique: undefined },
    ]);
  });
});
