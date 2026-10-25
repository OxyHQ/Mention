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
