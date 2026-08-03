import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { PostUser } from '@mention/shared-types';

import CollaboratorsList from '../CollaboratorsList';

/**
 * The panel behind a multi-author post's avatar cluster.
 *
 * It is one panel serving two different facts, and the heading is the only thing
 * that distinguishes them: several people co-wrote a post ("Collaborators"), or
 * ONE account published what ONE person wrote and chose to say so ("Published
 * by"). Calling the second one a collaboration says the channel and its writer
 * are peers on the post, which is exactly the relationship a channel exists to
 * NOT have. The caller decides — the panel has no `role` to read, because it
 * takes plain `PostUser` rows.
 */

const mockHeaderTitles: (string | undefined)[] = [];
jest.mock('@/components/Header', () => ({
  Header: ({ options }: { options?: { title?: string } }) => {
    mockHeaderTitles.push(options?.title);
    return null;
  },
}));

jest.mock('@/components/ui/Button', () => ({ IconButton: () => null }));
jest.mock('@/assets/icons/close-icon', () => ({ CloseIcon: () => null }));
jest.mock('@/components/ProfileCard', () => ({ ProfileCard: () => null }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@oxyhq/core', () => ({ getNormalizedUserHandle: () => 'nate' }));

// Resolves against the real `en.json` and ignores `defaultValue`, so a deleted
// key renders its raw name and fails rather than silently falling back.
jest.mock('react-i18next', () => {
  const strings: Record<string, string> = require('@/locales/en.json');
  return { useTranslation: () => ({ t: (key: string) => strings[key] ?? key }) };
});

const authors: PostUser[] = [
  { id: 'acct-notas', username: 'notas', name: { displayName: 'Notas de Nate' } },
  { id: 'acct-nate', username: 'nate', name: { displayName: 'Nate Isern' } },
];

function renderList(title?: string) {
  act(() => {
    TestRenderer.create(
      <CollaboratorsList authors={authors} onClose={jest.fn()} title={title} />,
    );
  });
  return mockHeaderTitles[mockHeaderTitles.length - 1];
}

describe('CollaboratorsList heading', () => {
  beforeEach(() => {
    mockHeaderTitles.length = 0;
  });

  it('says "Collaborators" when the caller names no other relationship', () => {
    expect(renderList(undefined)).toBe('Collaborators');
  });

  it('uses the caller’s heading — a channel naming its writer is not a collaboration', () => {
    expect(renderList('Published by')).toBe('Published by');
  });
});
