// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import {
  type DiscardDraftDialogDeps,
  discardDraftDialogActions,
} from '@/components/Compose/composeDialogActions';

function makeDeps(overrides: Partial<DiscardDraftDialogDeps> = {}): DiscardDraftDialogDeps {
  return {
    t: (_key, defaultValue) => defaultValue,
    saveDraft: jest.fn(async () => undefined),
    discardDraft: jest.fn(async () => undefined),
    dismiss: jest.fn(),
    reportError: jest.fn(),
    notifyError: jest.fn(),
    ...overrides,
  };
}

const action = (deps: DiscardDraftDialogDeps, label: string) => {
  const found = discardDraftDialogActions(deps).find((candidate) => candidate.label === label);
  if (!found) throw new Error(`no "${label}" action`);
  return found;
};

describe('discardDraftDialogActions', () => {
  it('offers save, discard and keep editing in that order', () => {
    expect(discardDraftDialogActions(makeDeps()).map((a) => [a.label, a.color])).toEqual([
      ['Save draft', 'default'],
      ['Discard', 'destructive'],
      ['Keep editing', 'cancel'],
    ]);
  });

  it('leaves only after the draft is stored', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      saveDraft: jest.fn(async () => {
        order.push('saved');
      }),
      dismiss: jest.fn(() => {
        order.push('dismissed');
      }),
    });
    await action(deps, 'Save draft').onPress?.();
    expect(order).toEqual(['saved', 'dismissed']);
  });

  it('keeps the author in the composer when the save fails', async () => {
    const failure = new Error('offline');
    const deps = makeDeps({ saveDraft: jest.fn(async () => Promise.reject(failure)) });
    await action(deps, 'Save draft').onPress?.();
    expect(deps.dismiss).not.toHaveBeenCalled();
    expect(deps.reportError).toHaveBeenCalledWith('Failed to save draft', failure);
  });

  it('discards and leaves', async () => {
    const deps = makeDeps();
    await action(deps, 'Discard').onPress?.();
    expect(deps.discardDraft).toHaveBeenCalledTimes(1);
    expect(deps.dismiss).toHaveBeenCalledTimes(1);
    expect(deps.notifyError).not.toHaveBeenCalled();
  });

  it('still leaves when the stored copy cannot be deleted, and says so', async () => {
    const failure = new Error('locked');
    const deps = makeDeps({ discardDraft: jest.fn(async () => Promise.reject(failure)) });
    await action(deps, 'Discard').onPress?.();
    expect(deps.reportError).toHaveBeenCalledWith('Failed to delete the discarded draft', failure);
    expect(deps.notifyError).toHaveBeenCalledWith('Failed to delete draft');
    expect(deps.dismiss).toHaveBeenCalledTimes(1);
  });

  it('does nothing on keep editing', () => {
    expect(action(makeDeps(), 'Keep editing').onPress).toBeUndefined();
  });
});
