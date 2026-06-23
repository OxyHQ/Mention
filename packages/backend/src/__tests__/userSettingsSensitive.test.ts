import { describe, it, expect } from 'vitest';

import { UserSettings } from '../models/UserSettings';

/**
 * Schema-level coverage for the `privacy.showSensitiveContent` preference.
 *
 * Mongoose applies schema defaults when a document is CONSTRUCTED (`new Model`),
 * so this verifies the safe default + that the field accepts an explicit value
 * without needing a live MongoDB connection.
 */
describe('UserSettings.privacy.showSensitiveContent', () => {
  it('defaults to false when the privacy subdocument is present but the flag is unset', () => {
    const doc = new UserSettings({ oxyUserId: 'user-1', privacy: { profileVisibility: 'public' } });
    expect(doc.privacy?.showSensitiveContent).toBe(false);
  });

  it('defaults to false via the schema default privacy subdocument', () => {
    const doc = new UserSettings({ oxyUserId: 'user-2' });
    expect(doc.privacy?.showSensitiveContent).toBe(false);
  });

  it('accepts and round-trips an explicit true value', () => {
    const doc = new UserSettings({
      oxyUserId: 'user-3',
      privacy: { profileVisibility: 'public', showSensitiveContent: true },
    });
    expect(doc.privacy?.showSensitiveContent).toBe(true);
  });

  it('accepts and round-trips an explicit false value', () => {
    const doc = new UserSettings({
      oxyUserId: 'user-4',
      privacy: { profileVisibility: 'public', showSensitiveContent: false },
    });
    expect(doc.privacy?.showSensitiveContent).toBe(false);
  });

  it('passes schema validation with the boolean flag set', async () => {
    const doc = new UserSettings({
      oxyUserId: 'user-5',
      privacy: { profileVisibility: 'public', showSensitiveContent: true },
    });
    await expect(doc.validate()).resolves.toBeUndefined();
  });
});
