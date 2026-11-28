// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { TFunction } from 'i18next';
import { showActionMenu } from '@/components/common/ActionMenu';
import { buildMenuGroups } from '@/components/common/actionMenuGroups';
import { showRepostMenu } from '../showRepostMenu';

jest.mock('@/components/common/ActionMenu', () => ({ showActionMenu: jest.fn() }));
const t = ((_key: string, fallback: string) => fallback) as TFunction;

it.each([false, true])(
  'offers repost and quote without publishing on open (boosted=%s)',
  (isReposted) => {
    const onRepost = jest.fn();
    const onQuote = jest.fn();
    showRepostMenu({ isBoosted: isReposted, quotesDisabled: false, t, onRepost, onQuote });
    const request = jest.mocked(showActionMenu).mock.calls.at(-1)![0];
    expect(request.groups[0].map((action) => action.label)).toEqual([
      isReposted ? 'Undo repost' : 'Repost',
      'Quote',
    ]);
    expect(onRepost).not.toHaveBeenCalled();
    expect(onQuote).not.toHaveBeenCalled();
    const close = jest.fn();
    const actions = buildMenuGroups(request.groups, close)[0];
    actions[1].onPress();
    expect(onQuote).toHaveBeenCalledTimes(1);
    expect(onRepost).not.toHaveBeenCalled();
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(onQuote.mock.invocationCallOrder[0]);
    actions[0].onPress();
    expect(onRepost).toHaveBeenCalledTimes(1);
  },
);

it('respects the author disabling quotes', () => {
  showRepostMenu({
    isBoosted: false,
    quotesDisabled: true,
    t,
    onRepost: jest.fn(),
    onQuote: jest.fn(),
  });
  expect(
    jest
      .mocked(showActionMenu)
      .mock.calls.at(-1)![0]
      .groups[0].map((action) => action.label),
  ).toEqual(['Repost']);
});
