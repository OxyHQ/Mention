import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import ComposeScheduleIndicator from '@/components/Compose/ComposeScheduleIndicator';
import PostHeader from '@/components/Post/PostHeader';

/**
 * The publish time belongs in the author row's time slot — the spot that reads
 * "now" until a time is picked. Four things are load-bearing there and none of
 * them shows up in a type-check:
 *
 *  1. The slot opens the picker in BOTH states. It used to render only once a
 *     time existed, so the initial row was a dead "now" and a post could only be
 *     scheduled for the FIRST time from a separate button — while an already
 *     scheduled one could be changed by tapping the row. Exactly backwards, and
 *     the reason this component now owns the unscheduled word too.
 *  2. "now" is REPLACED, not joined — a row showing both would answer "when does
 *     this go out" two ways.
 *  3. The visible text is just the date, in the same style as the word it
 *     stands in for. No "Scheduled" prefix, no tint, no bolder weight: the slot
 *     is a quiet fact on the identity line, not a badge.
 *  4. Which is exactly why the accessibility label still says the state in full.
 *     A screen reader has no tint and no surrounding context to infer it from,
 *     so abbreviating what is SEEN is not a reason to abbreviate what is HEARD.
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

/** Short, as the composer now formats it: day and time, no year for this year. */
const SCHEDULED_LABEL = 'Aug 2, 9:30 AM';

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
      /^(Scheduled for|Schedule this post)/.test(node.props.accessibilityLabel),
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

  it('shows the date alone — no "Scheduled" prefix restating what the label says', () => {
    const tree = render();

    expect(textContent(tree)).toContain(SCHEDULED_LABEL);
    // The word moved to the accessibility label, which is asserted below. Left
    // here too it made the identity line read as a badge rather than the quiet
    // time slot it stands in.
    expect(textContent(tree)).not.toContain('Scheduled');

    act(() => tree.unmount());
  });

  it('reads "now" and stays PRESSABLE before a time is picked', () => {
    const onPress = jest.fn();
    const tree = render({ scheduledLabel: null, onPress });

    expect(textContent(tree)).toContain('now');

    // The bug this replaces: the row was rendered only once a time existed, so
    // the first schedule could not be set from the place that shows it. A test
    // that only rendered the scheduled state could not see that at all.
    act(() => scheduleControl(tree).props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(scheduleControl(tree).props.accessibilityLabel).toBe('Schedule this post');

    act(() => tree.unmount());
  });

  it('announces the scheduled STATE, not just the action', () => {
    const tree = render();

    // The visible text is only a date now, so this is the sole place a screen
    // reader learns the post is scheduled rather than already posted.
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
   * The slot must look like the label it stands in for, in BOTH states: same
   * class list, and no inline colour at all. The inline-colour half is the old
   * trap — accent roles resolve to `rgb(...)`, so `` `${primary}1A` `` yields a
   * string react-native-web reads back as FULLY OPAQUE, which is how a control
   * ends up painting primary on primary and vanishing.
   */
  it('wears the same style as the word it replaces, scheduled or not', () => {
    const expected = 'text-muted-foreground text-[15px] leading-tight web:whitespace-nowrap';

    for (const scheduledLabel of [SCHEDULED_LABEL, null]) {
      const tree = render({ scheduledLabel });

      const [label] = tree.root.findAllByType(Text);
      expect(label.props.className).toBe(expected);

      const everyStyle = tree.root
        .findAllByType(Text)
        .flatMap((node) => [node.props.style].flat())
        .filter(Boolean);
      expect(everyStyle.some((entry) => 'color' in (entry as object))).toBe(false);

      act(() => tree.unmount());
    }
  });

  it('dims rather than disappears while the post is going out', () => {
    const tree = render({ disabled: true });

    // The time is still the answer to "when does this publish" mid-publish;
    // dropping it would make the row claim "now" during a scheduled post.
    expect(textContent(tree)).toContain(SCHEDULED_LABEL);
    expect(scheduleControl(tree).props.disabled).toBe(true);

    act(() => tree.unmount());
  });

  /**
   * The publish time is a property of the BATCH — the thread controller reads
   * one `scheduledFor` off the top level and stamps every entry with it — so
   * every box shows the same node. Sharing ONE element is what makes them
   * unable to disagree; the failure this guards is the quiet one, where
   * clearing the schedule reverts the box that cleared it and leaves the others
   * advertising a time nothing will publish at.
   */
  it('is one node the composer can hand to every box, so they cannot diverge', () => {
    const slot = <ComposeScheduleIndicator scheduledLabel={SCHEDULED_LABEL} onPress={() => {}} />;

    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(
        <>
          <PostHeader user={{ displayName: 'Nate', handle: 'nate' }} timeSlot={slot} />
          <PostHeader user={{ displayName: 'Nate', handle: 'nate' }} timeSlot={slot} />
        </>,
      );
    });
    if (!tree) throw new Error('PostHeader failed to render');
    const rows = tree;

    const rendered = textContent(rows).split(' | ');
    expect(rendered.filter((entry) => entry === SCHEDULED_LABEL)).toHaveLength(2);
    // Neither row falls back to its own label — that fallback is what a box
    // without the slot shows, and it is what "now under a date" looks like.
    expect(rendered).not.toContain('now');

    act(() => rows.unmount());
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
