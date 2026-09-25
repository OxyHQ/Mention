import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

import PostHeader from '../PostHeader';

/**
 * A post header's relative time follows the clock, not the row's first render.
 *
 * #1140 item 23: a profile that boosted its own post drew "Reposted by … 21m"
 * over the original, and then the same original again reading "now". The API
 * sent both dates, and the shared post cache keeps them through every write the
 * session made (`postsStoreCreatedAt.test.ts`). The "now" was the label the row
 * computed when it first rendered, seconds after the post was published, which
 * nothing recomputed afterwards: a pull-to-refresh re-delivers the SAME
 * `createdAt`, so a label derived only from the date stayed "now" for as long
 * as the row stayed mounted. The boost row was mounted later, so it read right.
 *
 * This replays that row: mounted at publish time, re-rendered by the refresh
 * 21 minutes later with the identical date.
 */

const mockToast = jest.fn();
jest.mock('@oxy.so/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));

// Host element names rather than components, so the props the header computed
// survive into the rendered tree verbatim — the marker is found as the host
// element the header rendered, not by a re-encoding of it.
jest.mock('@oxy.so/bloom/icons', () => ({ RiChat3Fill: 'RiChat3Fill', RiMoreFill: 'RiMoreFill' }));
jest.mock('@/assets/icons/draw-icon', () => ({ DrawIcon: 'DrawIcon' }));
jest.mock('@/components/ui/LiveAvatar', () => ({ LiveAvatar: 'LiveAvatar' }));
jest.mock('@oxy.so/bloom/avatar-group', () => ({ AvatarGroup: 'AvatarGroup' }));
jest.mock('../../UserName', () => ({ __esModule: true, default: 'UserName' }));

jest.mock('@oxy.so/bloom/theme', () => ({
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

jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: (user: { username?: string | null } | null | undefined) =>
    user?.username?.trim().replace(/^@+/, '') || null,
}));

const PUBLISHED_AT = '2026-09-25T10:59:57.629Z';

function timeLabel(renderer: TestRenderer.ReactTestRenderer): string {
  const texts = renderer.root
    .findAllByType(Text)
    .map((node) => [node.props.children].flat(Infinity).join(''))
    .filter((text) => text.startsWith('\u00B7'));
  return texts[0] ?? '';
}

function header(date: string | undefined) {
  return <PostHeader user={{ displayName: 'QA', handle: 'qatest0925' }} date={date} />;
}

describe('PostHeader relative time (#1140 item 23)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-25T11:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reads "now" when the row mounts at publish time, and 21m once 21 minutes pass', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(header(PUBLISHED_AT));
    });
    expect(timeLabel(renderer)).toBe('\u00B7 now');

    // Time passes with the row on screen, then the refresh hands it the same date.
    act(() => {
      // 21 minutes on the wall clock (fake timers move it with the timers).
      jest.advanceTimersByTime(21 * 60_000 + 30_000);
    });
    act(() => {
      renderer.update(header(PUBLISHED_AT));
    });
    expect(timeLabel(renderer)).toBe('\u00B7 21m');

    act(() => renderer.unmount());
  });

  it('still reads "now" for a post with no date (the composer preview)', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(header(undefined));
    });
    expect(timeLabel(renderer)).toBe('\u00B7 now');
    act(() => {
      jest.advanceTimersByTime(60 * 60_000);
    });
    expect(timeLabel(renderer)).toBe('\u00B7 now');
    act(() => renderer.unmount());
  });
});
