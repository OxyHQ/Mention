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
