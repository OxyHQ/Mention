import { describe, expect, it } from 'bun:test';
import { canUseCommunities } from '../src/community';

describe('canUseCommunities', () => {
  it('admits only the preview handles, whatever their case or spacing', () => {
    expect(canUseCommunities('oxy')).toBe(true);
    expect(canUseCommunities(' Nate ')).toBe(true);
    expect(canUseCommunities('nathan')).toBe(false);
    expect(canUseCommunities('')).toBe(false);
    expect(canUseCommunities(null)).toBe(false);
    expect(canUseCommunities(undefined)).toBe(false);
  });
});
