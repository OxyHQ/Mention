import { describe, expect, it } from 'vitest';
import { isActivityPubAccept } from '../../utils/federation/constants';

describe('isActivityPubAccept', () => {
  it('matches ActivityPub and JSON-LD Accept variants used for actor discovery', () => {
    expect(isActivityPubAccept('application/activity+json')).toBe(true);
    expect(isActivityPubAccept('Application/Activity+Json')).toBe(true);
    expect(isActivityPubAccept('application/ld+json')).toBe(true);
    expect(isActivityPubAccept('application/ld+json; profile="https://www.w3.org/ns/activitystreams"')).toBe(true);
    expect(isActivityPubAccept('text/html, application/ld+json;q=0.9')).toBe(true);
  });

  it('does not match ordinary browser HTML requests', () => {
    expect(isActivityPubAccept(undefined)).toBe(false);
    expect(isActivityPubAccept('text/html,application/xhtml+xml')).toBe(false);
  });
});
