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
});
