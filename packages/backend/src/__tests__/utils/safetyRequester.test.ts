import { describe, expect, it } from 'bun:test';
import { ApiError } from '../../utils/error';
import { safetyRequesterFor } from '../../utils/safetyRequester';

describe('safetyRequesterFor', () => {
  it('refuses a capability caller with a typed 403, not a server fault', () => {
    const request = { capability: { claims: { resource: { effectiveAccountId: 'acct' } } } };
    let thrown: unknown;
    try {
      safetyRequesterFor(request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown).toMatchObject({ statusCode: 403, code: 'SAFETY_REQUESTER_UNPROVABLE' });
  });
  it('forwards the actual capability operation proof without a user/session substitute', () => {
    expect(safetyRequesterFor({ capability: { ticket: 'signed-original-ticket' } })).toEqual({
      capabilityTicket: 'signed-original-ticket',
    });
  });
  /**
   * Only what the auth middleware VERIFIED is a person's proof. A raw
   * `Authorization` header — one the optional mount refused, or never saw —
   * is not forwarded as one.
   */
  it('forwards the verified bearer, never a raw Authorization header', () => {
    expect(
      safetyRequesterFor({ accessToken: 'verified', headers: { authorization: 'Bearer raw' } }),
    ).toEqual({ accessToken: 'verified' });
    expect(safetyRequesterFor({ headers: { authorization: 'Bearer unverified' } })).toEqual({
      accessToken: null,
    });
    expect(() =>
      safetyRequesterFor({ user: { id: 'person' }, headers: { authorization: 'Bearer raw' } }),
    ).toThrow('original authenticated bearer');
  });
});

describe('verified service requester context', () => {
  const own = {
    user: { id: 'person' },
    serviceApp: { authority: 'first_party' as const },
    accessToken: 'service-jwt-never-user-session',
    serviceActingAs: {
      authority: 'first_party' as const,
      userId: 'person',
      requesterContext: 'central-short-lived-context',
    },
  };
  it('forwards only the context derived for this recipient and account', () => {
    expect(safetyRequesterFor(own)).toEqual({ requesterContext: 'central-short-lived-context' });
  });
  it('refuses legacy attribution, an external credential, and a different account', () => {
    for (const request of [
      { ...own, serviceActingAs: undefined },
      { ...own, serviceApp: { authority: 'external' as const } },
      { ...own, user: { id: 'bot-owner' } },
    ])
      expect(() => safetyRequesterFor(request)).toThrow(
        'Verified downstream requester proof is required',
      );
  });
});
