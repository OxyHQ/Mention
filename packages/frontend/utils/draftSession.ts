// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/** Allocate a stable device-draft ID before its first asynchronous write. */
export const createDraftId = (): string =>
  `draft_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

export interface DraftSession {
  id: string | null;
  /** null means the session is creating a new draft; 0 is a legacy draft. */
  revision: number | null;
  closed: boolean;
  conflicted: boolean;
}

export class DraftConflictError extends Error {
  constructor() {
    super('The draft was changed or deleted in another session');
    this.name = 'DraftConflictError';
  }
}

export function draftRevision(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw new DraftConflictError();
}
