import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import ComposeScheduleIndicator from '@/components/Compose/ComposeScheduleIndicator';
import PostHeader from '@/components/Post/PostHeader';

/**
 * The publish time belongs in the author row's time slot — the spot that reads
 * "now" until a time is picked. Two things are load-bearing there and neither
 * shows up in a type-check: the word "now" must actually be REPLACED (a time
 * rendered beside it would leave the row claiming both), and the accessibility
 * label has to announce the scheduled state, since a screen reader has no tint
 * to read and this row is now the only place the time appears.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; time?: string }) => {
      const template = options?.defaultValue ?? key;
      return options?.time ? template.replace('{{time}}', options.time) : template;
    },
    i18n: { language: 'en-US' },
  }),
}));

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({
    colors: {
      border: '#333',
      card: '#fff',
      primary: '#7c3aed',
      text: '#000',
      textSecondary: '#666',
      textTertiary: '#999',
    },
  }),
}));

jest.mock('@oxyhq/bloom/hooks', () => ({ useHaptics: () => jest.fn() }));
jest.mock('@oxyhq/bloom/pressable-scale', () => {
  const { TouchableOpacity } = jest.requireActual<typeof import('react-native')>('react-native');
  return { PressableScale: TouchableOpacity };
});
jest.mock('@oxyhq/bloom/avatar-group', () => ({ AvatarGroup: () => null }));
jest.mock('@oxyhq/bloom/toast', () => ({ toast: jest.fn() }));
// The federated badge drags Bloom's dialog into the module graph and never
// renders here: `PostHeader` only mounts it for a federated author.
jest.mock('@/components/Fediverse/FediverseBadge', () => ({ RemoteActorBadge: () => null }));
// `@oxyhq/core` ships ESM that jest does not transform, and only the collab
// byline calls into it — a solo header never reaches this.
jest.mock('@oxyhq/core', () => ({ getNormalizedUserHandle: () => '' }));
jest.mock('@/components/ui/LiveAvatar', () => ({ LiveAvatar: () => null }));
jest.mock('@/components/ProfileHoverCard', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ProfileHoverCard: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  };
});

const SCHEDULED_LABEL = 'Aug 2, 2026, 9:30 AM';

function textContent(tree: TestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string')
    .join(' | ');
}

function scheduleControl(tree: TestRenderer.ReactTestRenderer) {
  return tree.root.find(
    (node) =>
      node.props.accessibilityRole === 'button' &&
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Scheduled for'),
  );
}

describe('ComposeScheduleIndicator', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  function render(props: Partial<React.ComponentProps<typeof ComposeScheduleIndicator>> = {}) {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(
        <ComposeScheduleIndicator
          scheduledLabel={SCHEDULED_LABEL}
          onPress={() => {}}
          {...props}
        />,
      );
    });
    if (!tree) throw new Error('ComposeScheduleIndicator failed to render');
    return tree;
  }

  it('says BOTH that the post is scheduled and when', () => {
    const tree = render();

    // A bare timestamp in the row where "now" was reads as "posted then", not
    // "will post then" — the word is what makes the tense unambiguous.
    expect(textContent(tree)).toContain('Scheduled');
    expect(textContent(tree)).toContain(SCHEDULED_LABEL);

    act(() => tree.unmount());
  });

  it('announces the scheduled STATE, not just the action', () => {
    const tree = render();

    expect(scheduleControl(tree).props.accessibilityLabel).toBe(
      `Scheduled for ${SCHEDULED_LABEL}. Tap to change.`,
    );

    act(() => tree.unmount());
  });

  it('reopens the picker when tapped, so the time stays changeable', () => {
    const onPress = jest.fn();
    const tree = render({ onPress });

    act(() => scheduleControl(tree).props.onPress());

    // The picker is also where clearing the schedule lives, so this press is the
    // only route back out of a scheduled post.
    expect(onPress).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });

  /**
   * The tint has to come from `text-primary`, not from concatenating hex alpha
   * onto a theme colour. Accent roles resolve to `rgb(...)`, so `` `${primary}1A` ``
   * yields a string react-native-web reads back as FULLY OPAQUE — which is how a
   * control ends up painting primary on primary and vanishing. Invisible to the
   * type-check and to every assertion above.
   */
  it('tints itself with a class, never a hand-built alpha colour', () => {
    const tree = render();

    const label = tree.root
      .findAllByType(Text)
      .find((node) => String(node.props.className ?? '').includes('text-primary'));
    expect(label).toBeDefined();

    const everyStyle = tree.root
      .findAllByType(Text)
      .flatMap((node) => [node.props.style].flat())
      .filter(Boolean);
    expect(everyStyle.some((entry) => 'color' in (entry as object))).toBe(false);

    act(() => tree.unmount());
  });

  it('dims rather than disappears while the post is going out', () => {
    const tree = render({ disabled: true });

    // The time is still the answer to "when does this publish" mid-publish;
    // dropping it would make the row claim "now" during a scheduled post.
    expect(textContent(tree)).toContain(SCHEDULED_LABEL);
    expect(scheduleControl(tree).props.disabled).toBe(true);

    act(() => tree.unmount());
  });
});

describe('PostHeader — the time slot the composer writes into', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  function renderHeader(timeSlot?: React.ReactNode) {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(
        <PostHeader
          user={{ displayName: 'Nate', handle: 'nate' }}
          timeSlot={timeSlot}
        />,
      );
    });
    if (!tree) throw new Error('PostHeader failed to render');
    return tree;
  }

  it('reads "now" with no slot passed — the composer\'s unscheduled row', () => {
    const tree = renderHeader(undefined);

    // The composer passes no `date`, so the relative label is "now". This is the
    // state the schedule indicator has to replace, and it must survive untouched
    // when nothing is scheduled.
    expect(textContent(tree)).toContain('now');

    act(() => tree.unmount());
  });

  it('REPLACES "now" with the slot, rather than rendering both', () => {
    const tree = renderHeader(
      <ComposeScheduleIndicator scheduledLabel={SCHEDULED_LABEL} onPress={() => {}} />,
    );

    const text = textContent(tree);
    expect(text).toContain(SCHEDULED_LABEL);
    // A row saying "now" AND a future time at once is the bug this replaces —
    // the header would be answering "when does this go out" two ways.
    expect(text.split(' | ')).not.toContain('now');

    act(() => tree.unmount());
  });
});
