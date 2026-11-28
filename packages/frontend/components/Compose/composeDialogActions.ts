// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/** One button of a Bloom confirmation dialog. */
export interface ComposeDialogAction {
  label: string;
  color: 'default' | 'destructive' | 'cancel';
  onPress?: () => void | Promise<void>;
}

export interface DiscardDraftDialogDeps {
  /** Translate with an English default, as `t(key, default)`. */
  t: (key: string, defaultValue: string) => string;
  /** Stores the composer's current content as a draft. */
  saveDraft: () => Promise<void>;
  /** Deletes the stored copy of the draft the composer was opened from. */
  discardDraft: () => Promise<void>;
  /** Leaves the composer. */
  dismiss: () => void;
  /** Records a failure for the logs. */
  reportError: (message: string, error: unknown) => void;
  /** Tells the author something failed. */
  notifyError: (message: string) => void;
}

/**
 * The buttons of the "save this as a draft?" prompt shown when the author leaves
 * a composer that has content.
 *
 * Saving leaves only once the draft is stored: a failed save keeps the author
 * here, with their words, rather than closing over them. Discarding always
 * leaves: the author chose to throw this work away, so a stored copy that could
 * not be deleted is reported but must not keep them in the composer.
 */
export function discardDraftDialogActions(deps: DiscardDraftDialogDeps): ComposeDialogAction[] {
  const { t } = deps;
  return [
    {
      label: t('compose.saveDraft', 'Save draft'),
      color: 'default',
      onPress: async () => {
        try {
          await deps.saveDraft();
          deps.dismiss();
        } catch (error) {
          deps.reportError('Failed to save draft', error);
        }
      },
    },
    {
      label: t('common.discard', 'Discard'),
      color: 'destructive',
      onPress: async () => {
        try {
          await deps.discardDraft();
        } catch (error) {
          deps.reportError('Failed to delete the discarded draft', error);
          deps.notifyError(t('compose.deleteDraftError', 'Failed to delete draft'));
        }
        deps.dismiss();
      },
    },
    {
      label: t('compose.keepEditing', 'Keep editing'),
      color: 'cancel',
    },
  ];
}
