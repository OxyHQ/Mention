import type { ComposeDraftRefs } from '@/hooks/useDraftManager';
import type { Draft } from '@/hooks/useDrafts';

export class DraftReadError extends Error {
  constructor(cause: unknown) {
    super('Could not read the selected draft', { cause });
    this.name = 'DraftReadError';
  }
}

export function sameDraftContent(a: ComposeDraftRefs, b: ComposeDraftRefs): boolean {
  return (Object.keys(a) as (keyof ComposeDraftRefs)[]).every(
    (key) => key === 'currentDraftId' || Object.is(a[key], b[key]),
  );
}

export function shouldPreservePublishedEditor(
  submitted: ComposeDraftRefs,
  current: ComposeDraftRefs,
  submittedSession: object,
  currentSession: object,
  submittedChoices: object,
  currentChoices: object,
  switchingDraft: boolean,
): boolean {
  return (
    switchingDraft ||
    submittedSession !== currentSession ||
    submittedChoices !== currentChoices ||
    !sameDraftContent(submitted, current)
  );
}

export async function prepareDraftSwitch(
  targetId: string,
  getSnapshot: () => ComposeDraftRefs,
  getSession: () => object,
  save: (snapshot: ComposeDraftRefs) => Promise<void>,
  readTarget: (id: string) => Promise<Draft | undefined>,
  isActive: () => boolean,
): Promise<
  { status: 'same' | 'cancelled' | 'changed' | 'missing' } | { status: 'ready'; draft: Draft }
> {
  const snapshot = getSnapshot();
  const session = getSession();
  if (snapshot.currentDraftId === targetId) return { status: 'same' };
  await save(snapshot);
  if (!isActive()) return { status: 'cancelled' };
  if (getSession() !== session || !sameDraftContent(snapshot, getSnapshot()))
    return { status: 'changed' };
  let target: Draft | undefined;
  try {
    target = await readTarget(targetId);
  } catch (error) {
    throw new DraftReadError(error);
  }
  if (!isActive()) return { status: 'cancelled' };
  if (getSession() !== session || !sameDraftContent(snapshot, getSnapshot()))
    return { status: 'changed' };
  return target ? { status: 'ready', draft: target } : { status: 'missing' };
}
