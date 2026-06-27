import { describe, expect, it } from 'vitest';
import {
  isBlockedDomain,
  OXY_IDENTITY_APEX,
} from '../../utils/federation/constants';

describe('OXY_IDENTITY_APEX', () => {
  it('derives the registrable domain of the Oxy API (api.oxy.so → oxy.so)', () => {
    // Default OXY_API_URL is https://api.oxy.so; its registrable domain is the
    // identity apex where every Oxy/Mention user is published via the DID layer.
    expect(OXY_IDENTITY_APEX).toBe('oxy.so');
  });
});

describe('isBlockedDomain', () => {
  it('blocks the Oxy identity apex so own users are never treated as remote', () => {
    expect(isBlockedDomain('oxy.so')).toBe(true);
    // Case-insensitive: callers pass actor hosts / acct domains verbatim.
    expect(isBlockedDomain('OXY.SO')).toBe(true);
  });

  it('blocks our own ActivityPub federation domain', () => {
    expect(isBlockedDomain('mention.earth')).toBe(true);
  });

  it('does not block legitimate remote federation domains', () => {
    expect(isBlockedDomain('mastodon.social')).toBe(false);
    expect(isBlockedDomain('threads.net')).toBe(false);
    // A different registrable domain that merely contains the apex string must
    // not be matched (substring safety).
    expect(isBlockedDomain('oxy.so.evil.example')).toBe(false);
    expect(isBlockedDomain('notoxy.so')).toBe(false);
  });
});
