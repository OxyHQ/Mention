import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PostUser } from '@mention/shared-types';
import { KnownLikersRow } from '../KnownLikersRow';

/**
 * Coverage for the post-detail social-proof row.
 *
 * Two things are load-bearing and easy to regress:
 *
 *  1. **It reserves NO height until it has something to say.** Signed-out, zero
 *     known likers, and the in-flight first fetch all render `null`. If any of
 *     them rendered an empty row instead, the whole stats block below would jump
 *     down the moment the query resolved — the exact reason `FollowedByRow`
 *     carries the same rule.
 *  2. **A pathologically long display name cannot eat the sentence.** The
 *     "and N others" tail carries the magnitude, so it has to survive; the names
 *     are capped rather than letting the row clip mid-name on a phone (the bug
 *     bluesky-social/social-app fixed in `821e1b838`).
 */

const mockUseKnownLikers = jest.fn();
jest.mock('@/hooks/useKnownLikers', () => ({
  useKnownLikers: (...args: unknown[]) => mockUseKnownLikers(...args),
}));

// Interpolate against the REAL en.json copy, including i18next's `_one`/`_other`
// plural suffixes, so a missing or misnamed key fails here instead of silently
// falling back to the inline `defaultValue`.
jest.mock('react-i18next', () => {
  const messages = jest.requireActual<Record<string, string>>('../../../locales/en.json');
  return {
    useTranslation: () => ({
      t: (key: string, options: Record<string, unknown> = {}) => {
        const count = options.count;
        const suffixed = typeof count === 'number' ? `${key}_${count === 1 ? 'one' : 'other'}` : key;
        const template = messages[suffixed] ?? messages[key];
        if (template === undefined) {
          throw new Error(`Missing i18n key: ${key}`);
        }
        return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options[name] ?? ''));
      },
    }),
  };
});

// The face pile is Bloom's; this suite is about the copy, so record the props
// and render nothing.
const mockAvatarGroupProps: Record<string, unknown>[] = [];
jest.mock('@oxyhq/bloom/avatar-group', () => ({
  AvatarGroup: (props: Record<string, unknown>) => {
    mockAvatarGroupProps.push(props);
    return null;
  },
}));

jest.mock('@oxyhq/core', () => ({
  getNormalizedUserHandle: (user: { username?: string } | null | undefined) =>
    user?.username ? user.username : null,
}));

function liker(id: string, displayName: string | undefined, username: string): PostUser {
  return { id, username, name: displayName ? { displayName } : {}, avatar: `file-${id}` };
}

function render(state: { likers: PostUser[]; total: number; isPending: boolean }) {
  mockUseKnownLikers.mockReturnValue(state);
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<KnownLikersRow postId="post-1" onPress={jest.fn()} />);
  });
  return renderer;
}

function renderedTexts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAvatarGroupProps.length = 0;
});

describe('KnownLikersRow — height is never reserved before there is something to say', () => {
  it('renders nothing while the first fetch is in flight', () => {
    const renderer = render({ likers: [liker('a', 'Ana', 'ana')], total: 4, isPending: true });
    expect(renderer.toJSON()).toBeNull();
  });

  it('renders nothing when the viewer follows none of the likers', () => {
    const renderer = render({ likers: [], total: 0, isPending: false });
    expect(renderer.toJSON()).toBeNull();
  });
});

describe('KnownLikersRow — copy', () => {
  it('names a single liker', () => {
    const renderer = render({ likers: [liker('a', 'Ana', 'ana')], total: 1, isPending: false });
    expect(renderedTexts(renderer)).toContain('Liked by Ana');
  });

  it('names both likers when exactly two are known', () => {
    const renderer = render({
      likers: [liker('a', 'Ana', 'ana'), liker('b', 'Luis', 'luis')],
      total: 2,
      isPending: false,
    });
    expect(renderedTexts(renderer)).toContain('Liked by Ana and Luis');
  });

  it('counts the remainder off the real total, not the sampled avatars', () => {
    const renderer = render({
      likers: [liker('a', 'Ana', 'ana'), liker('b', 'Luis', 'luis'), liker('c', 'Mo', 'mo')],
      total: 49,
      isPending: false,
    });
    // 49 known likers, 3 sampled, 2 named -> "and 47 others".
    expect(renderedTexts(renderer)).toContain('Liked by Ana, Luis and 47 others');
    // The face pile gets the real total too, so its overflow chip agrees.
    expect(mockAvatarGroupProps[0].total).toBe(49);
  });

  it('falls back to the handle when a liker has no display name', () => {
    const renderer = render({ likers: [liker('a', undefined, 'ana')], total: 1, isPending: false });
    expect(renderedTexts(renderer)).toContain('Liked by ana');
  });

  it('caps a very long name so the "and N others" tail survives', () => {
    const renderer = render({
      likers: [
        liker('a', 'Bartholomew Cubbins the Third of Didd', 'bart'),
        liker('b', 'Luis', 'luis'),
      ],
      total: 30,
      isPending: false,
    });

    const [label] = renderedTexts(renderer);
    expect(label).toContain('…');
    expect(label).toContain('and 28 others');
    expect(label).not.toContain('Cubbins the Third of Didd');
  });
});
