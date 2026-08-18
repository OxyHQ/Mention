import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';

import PostHeader from '../PostHeader';

/**
 * The edited marker in the identity line.
 *
 * It is a pencil and NOTHING else: the edit history is not public, so the marker
 * has nothing to open and tapping it only says what the pencil means. Three
 * things can break, and none of them throws:
 *
 *  1. The pencil appears on a post that was never edited. A marker that is
 *     always there says nothing, and reads as "every post on Mention was
 *     edited" — so the ABSENT case is what makes the present case mean anything.
 *     Without it a component that renders the pencil unconditionally passes.
 *  2. The pencil never appears at all. Silent: the row still renders.
 *  3. The tap says the wrong thing, or says the raw key. The `t` mock below
 *     resolves against the REAL `en.json` and deliberately ignores
 *     `defaultValue`, so a key deleted from the catalog renders `post.editedToast`
 *     and fails here rather than falling back to the colocated English and
 *     passing while every non-English reader sees the raw key.
 */

const mockToast = jest.fn();
jest.mock('@oxyhq/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));

// Host element names rather than components, so the props the header computed
// survive into the rendered tree verbatim — the pencil is found by the `name`
// the header passed, not by a re-encoding of it.
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@/components/ui/LiveAvatar', () => ({ LiveAvatar: 'LiveAvatar' }));
jest.mock('@oxyhq/bloom/avatar-group', () => ({ AvatarGroup: 'AvatarGroup' }));
jest.mock('../../UserName', () => ({ __esModule: true, default: 'UserName' }));

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#8899a6' } }),
}));

jest.mock('@/components/AccountBadge', () => ({ AccountBadge: () => null }));
jest.mock('@/assets/icons/boost-icon', () => ({ BoostIcon: () => null }));

/**
 * i18next's own resolution, narrowed to what this file needs: a flat dotted key
 * wins over a nested path, and a nested path resolves segment by segment. Both
 * shapes exist in `en.json`, and `post.editedToast` is a NESTED one — a mock
 * that only read flat keys would report every key here as missing.
 */
jest.mock('react-i18next', () => {
  const catalog: Record<string, unknown> = require('@/locales/en.json');
  const resolve = (key: string): string => {
    if (typeof catalog[key] === 'string') return catalog[key] as string;
    let current: unknown = catalog;
    for (const token of key.split('.')) {
      if (current === null || typeof current !== 'object') return key;
      current = (current as Record<string, unknown>)[token];
    }
    return typeof current === 'string' ? current : key;
  };
  return { useTranslation: () => ({ t: (key: string) => resolve(key) }) };
});

jest.mock('@oxyhq/core', () => ({
  getNormalizedUserHandle: (user: { username?: string | null } | null | undefined) =>
    user?.username?.trim().replace(/^@+/, '') || null,
}));

type HeaderProps = React.ComponentProps<typeof PostHeader>;

function render(props: Partial<HeaderProps> = {}): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <PostHeader user={{ displayName: 'Ana Torres', handle: 'ana' }} {...props} />,
    );
  });
  return renderer;
}

/** The pencil itself, found by the icon name the header passed. */
function pencils(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) => String(node.type) === 'Ionicons' && node.props?.name === 'pencil',
  );
}

/**
 * The pressable wrapping the pencil — the thing a reader actually taps.
 *
 * Walked UP from the pencil rather than read off `pencil.parent`, because those
 * are two different nodes and only one of them can be pressed. `TouchableOpacity`
 * renders a host `View` and hands Pressability's responder handlers
 * (`onStartShouldSetResponder`, `onResponderRelease`, …) to it, together with the
 * accessibility props — so the host View satisfies an `accessibilityLabel`
 * assertion while carrying no `onPress` at all. The `onPress` the header
 * configured stays on the COMPOSITE above it, which is why `.parent.props.onPress`
 * is `undefined` and calling it throws "is not a function".
 *
 * The walk stops at the FIRST ancestor whose `onPress` is callable, and then
 * checks that node is the marker's own button. Both halves are load-bearing:
 * a walk with no `accessibilityRole` check could keep climbing past a marker that
 * stopped wiring `onPress` and settle on some unrelated outer pressable — the
 * press test would go green while measuring a different button. Failing loudly
 * here is the point; there is no node this helper may return that does not press
 * the pencil.
 */
function editedButton(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance {
  let node: ReactTestInstance | null = pencils(renderer)[0] ?? null;
  if (node === null) {
    throw new Error('editedButton: no pencil rendered, so there is nothing to press.');
  }
  while (node !== null) {
    const onPress: unknown = node.props?.onPress;
    if (typeof onPress === 'function') {
      const role: unknown = node.props?.accessibilityRole;
      if (role !== 'button') {
        throw new Error(
          `editedButton: the nearest pressable ancestor of the pencil has accessibilityRole ` +
            `${JSON.stringify(role)}, not "button" — the walk drifted off the edited marker ` +
            `onto another pressable, so pressing it would prove nothing about the marker.`,
        );
      }
      return node;
    }
    node = node.parent;
  }
  throw new Error(
    'editedButton: no ancestor of the pencil carries a callable `onPress` — the edited marker ' +
      'is not pressable, so nothing tells a reader what the pencil means.',
  );
}

beforeEach(() => {
  mockToast.mockClear();
});

describe('PostHeader edited marker', () => {
  it('renders NOTHING when the post carries no `isEdited` at all', () => {
    // The positive control. A post whose DTO predates the flag, or which the
    // server simply did not mark, must look exactly like it always has.
    expect(pencils(render())).toHaveLength(0);
  });

  it('renders nothing when the post was explicitly NOT edited', () => {
    expect(pencils(render({ isEdited: false }))).toHaveLength(0);
  });

  it('renders one pencil when the post WAS edited', () => {
    const renderer = render({ isEdited: true });
    const found = pencils(renderer);
    expect(found).toHaveLength(1);
    // 12px, matching the `chatbubble` indicator that shares this row — a
    // marker sized like an action-bar glyph would read as one.
    expect(found[0].props.size).toBe(12);
  });

  it('labels the marker from the catalog, not from a raw key', () => {
    expect(editedButton(render({ isEdited: true })).props.accessibilityLabel).toBe('Edited');
  });

  it('explains the marker on press — and does nothing else', () => {
    const onPressUser = jest.fn();
    const onPressAvatar = jest.fn();
    const renderer = render({ isEdited: true, onPressUser, onPressAvatar });

    act(() => {
      editedButton(renderer).props.onPress();
    });

    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith('This post was edited');
    // No navigation, no profile press, no history sheet: the marker is the
    // whole feature, so a tap that ALSO did something would be the bug.
    expect(onPressUser).not.toHaveBeenCalled();
    expect(onPressAvatar).not.toHaveBeenCalled();
  });

  it('does not toast on a post that was never edited — there is nothing to press', () => {
    render({ isEdited: false });
    expect(mockToast).not.toHaveBeenCalled();
  });
});
