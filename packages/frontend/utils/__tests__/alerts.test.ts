// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

const mockConfirm = jest.fn();
jest.mock('@oxy.so/bloom/surfaces', () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

import { confirmDialog } from '../alerts';

it('passes the owner’s cancellation signal to the shared confirmation', async () => {
  mockConfirm.mockResolvedValue(false);
  const controller = new AbortController();
  const onClosed = jest.fn();
  await expect(
    confirmDialog({ title: 'Confirm', signal: controller.signal, onClosed }),
  ).resolves.toBe(false);
  expect(mockConfirm).toHaveBeenCalledWith(
    expect.objectContaining({ signal: controller.signal, onClosed }),
  );
});
