import { describe, it, expect } from 'vitest';

/**
 * The `source` provenance subfield on the StarterPack model: it marks a pack as
 * mirrored from an external network (read-only) and is the sparse-unique dedup key
 * for re-sync. Offline construct → validateSync → index-declaration checks (the
 * repo has no mongodb-memory-server); no DB connection is opened.
 */

import StarterPack from '../models/StarterPack';

describe('StarterPack model — external source', () => {
  it('round-trips a valid atproto source subdoc', () => {
    const now = new Date();
    const doc = new StarterPack({
      ownerOxyUserId: 'oxy-federated',
      name: 'Mirrored pack',
      memberOxyUserIds: ['m1', 'm2'],
      source: { network: 'atproto', uri: 'at://did:plc:x/app.bsky.graph.starterpack/p1', syncedAt: now },
    });
    expect(doc.validateSync()).toBeUndefined();
    const obj = doc.toObject();
    expect(obj.source?.network).toBe('atproto');
    expect(obj.source?.uri).toBe('at://did:plc:x/app.bsky.graph.starterpack/p1');
    expect(obj.source?.syncedAt).toEqual(now);
  });

  it('still constructs a native pack with no source', () => {
    const doc = new StarterPack({ ownerOxyUserId: 'oxy-1', name: 'Native', memberOxyUserIds: ['a'] });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.toObject().source).toBeUndefined();
  });

  it('rejects an unknown source network via schema validation', () => {
    const doc = new StarterPack({
      ownerOxyUserId: 'oxy-1',
      name: 'Bad source',
      source: { network: 'nostr', uri: 'x', syncedAt: new Date() },
    });
    const error = doc.validateSync();
    expect(error).toBeDefined();
    expect(error?.errors['source.network']).toBeDefined();
  });

  it('declares a sparse UNIQUE index on source.uri (the re-sync dedup key)', () => {
    const indexes = StarterPack.schema.indexes();
    const sourceIndex = indexes.find(([keys]) => Object.prototype.hasOwnProperty.call(keys, 'source.uri'));
    expect(sourceIndex).toBeDefined();
    const [, options] = sourceIndex ?? [{}, {}];
    expect(options).toMatchObject({ unique: true, sparse: true });
  });
});
