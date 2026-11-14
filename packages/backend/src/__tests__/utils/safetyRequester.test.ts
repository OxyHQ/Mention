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
  it('asks for the ticket’s account on Mention’s declared authority, never with the ticket', () => {
    expect(
      safetyRequesterFor({
        capability: {
          ticket: 'signed-original-ticket',
          claims: { resource: { effectiveAccountId: 'acct' } },
        },
      }),
    ).toEqual({ actingForAccountId: 'acct' });
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

describe('another Oxy service acting for an account (ADR 0066)', () => {
  const own = {
    user: { id: 'person' },
    serviceApp: { authority: 'first_party' as const },
    accessToken: 'service-jwt-never-user-session',
    serviceActingAs: { authority: 'first_party' as const, userId: 'person', requesterId: 'person' },
  };
  it('asks for the account Oxy verified, never with the service JWT', () => {
    expect(safetyRequesterFor(own)).toEqual({ actingForAccountId: 'person' });
  });
  it('refuses legacy attribution, an external credential, and a different account', () => {
    for (const request of [
      { ...own, serviceActingAs: undefined },
      { ...own, serviceApp: { authority: 'external' as const } },
      { ...own, user: { id: 'bot-owner' } },
    ])
      expect(() => safetyRequesterFor(request)).toThrow(
        'A verified first-party service account is required',
      );
  });
});
