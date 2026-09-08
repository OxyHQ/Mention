import { describe, expect, it } from 'bun:test';
import { isOxyId } from '../src/oxyIds';

/**
 * The predicate exists because the shape of an Oxy id CHANGED, so the cases
 * that matter are the two live shapes and the things that must not be mistaken
 * for either. A version-pinned uuid pattern passes a v4 sample and fails every
 * real id, which is exactly how the rule this replaces went stale unnoticed.
 */
describe('isOxyId', () => {
  it('accepts the pre-cutover Mongo ObjectId shape', () => {
    expect(isOxyId('65fdc8c8c8c8c8c8c8c8c8c8')).toBe(true);
    expect(isOxyId('507F1F77BCF86CD799439011')).toBe(true);
  });

  it('accepts a uuid v7 — the shape Oxy has minted since 2026-07-31', () => {
    expect(isOxyId('01a0821e-d61a-7a78-b5d1-afb1850bd5a4')).toBe(true);
  });

  it('accepts other uuid versions rather than pinning the version nibble', () => {
    expect(isOxyId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('rejects handles, and the near-misses that would break a lookup', () => {
    expect(isOxyId('alice')).toBe(false);
    expect(isOxyId('alice@social.example')).toBe(false);
    expect(isOxyId('')).toBe(false);
    // 23 and 25 hex chars: neither is an ObjectId.
    expect(isOxyId('65fdc8c8c8c8c8c8c8c8c8c')).toBe(false);
    expect(isOxyId('65fdc8c8c8c8c8c8c8c8c8c8c')).toBe(false);
    // A uuid with the wrong variant nibble is not one.
    expect(isOxyId('01a0821e-d61a-7a78-c5d1-afb1850bd5a4')).toBe(false);
    // Whitespace is not trimmed away into a match.
    expect(isOxyId(' 65fdc8c8c8c8c8c8c8c8c8c8 ')).toBe(false);
  });
});
