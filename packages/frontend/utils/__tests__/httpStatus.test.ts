import { getHttpStatus, isNotFoundError, isUnauthorizedError } from '../httpStatus';

describe('getHttpStatus', () => {
  it('reads an axios error status from its response', () => {
    expect(getHttpStatus({ response: { status: 404 } })).toBe(404);
  });

  it('reads the Oxy SDK error status from the error itself', () => {
    expect(getHttpStatus(Object.assign(new Error('x'), { status: 401 }))).toBe(401);
  });

  it('answers undefined for anything without a numeric status', () => {
    expect(getHttpStatus(null)).toBeUndefined();
    expect(getHttpStatus('boom')).toBeUndefined();
    expect(getHttpStatus({ response: { status: '404' } })).toBeUndefined();
    expect(getHttpStatus({ status: 'bad' })).toBeUndefined();
    expect(getHttpStatus({})).toBeUndefined();
  });

  it('names the two statuses callers branch on', () => {
    expect(isNotFoundError({ status: 404 })).toBe(true);
    expect(isNotFoundError({ status: 500 })).toBe(false);
    expect(isUnauthorizedError({ response: { status: 401 } })).toBe(true);
    expect(isUnauthorizedError({ status: 403 })).toBe(false);
  });
});
