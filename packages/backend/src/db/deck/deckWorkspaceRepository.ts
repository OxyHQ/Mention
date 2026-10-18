import type { DeckWorkspaceResponse, DeckWorkspaceState } from '@mention/shared-types/deck';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { deckWorkspaces } from '../schema/deck';

const projection = { revision: deckWorkspaces.revision, state: deckWorkspaces.state };

export async function loadDeckWorkspace(oxyUserId: string): Promise<DeckWorkspaceResponse> {
  const [row] = await getDb()
    .select(projection)
    .from(deckWorkspaces)
    .where(eq(deckWorkspaces.oxyUserId, oxyUserId));
  return row ?? { revision: 0, state: null };
}

/** Storage operations selected by the workspace service, not inferred from HTTP state. */
export type DeckWorkspaceWrite =
  | { kind: 'replace'; state: DeckWorkspaceState }
  | { kind: 'sync-preference'; syncEnabled: boolean; initialState: DeckWorkspaceState };

/** Compare-and-swap: competing devices never silently replace one another's edits. */
export async function compareAndSwapDeckWorkspace(
  oxyUserId: string,
  baseRevision: number,
  write: DeckWorkspaceWrite,
): Promise<{ saved: boolean; workspace: DeckWorkspaceResponse }> {
  const db = getDb();
  let rows: DeckWorkspaceResponse[];
  if (baseRevision === 0) {
    const initialState = write.kind === 'replace' ? write.state : write.initialState;
    rows = await db
      .insert(deckWorkspaces)
      .values({ oxyUserId, revision: 1, state: initialState })
      .onConflictDoNothing({ target: deckWorkspaces.oxyUserId })
      .returning(projection);
  } else {
    rows = await db
      .update(deckWorkspaces)
      .set({
        revision: sql`${deckWorkspaces.revision} + 1`,
        // Apply the preference to the existing document inside the revisioned
        // UPDATE: reading it first would race another device's workspace write.
        state:
          write.kind === 'replace'
            ? write.state
            : sql`jsonb_set(${deckWorkspaces.state}, '{syncEnabled}', ${JSON.stringify(write.syncEnabled)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(
        and(eq(deckWorkspaces.oxyUserId, oxyUserId), eq(deckWorkspaces.revision, baseRevision)),
      )
      .returning(projection);
  }
  return rows[0]
    ? { saved: true, workspace: rows[0] }
    : { saved: false, workspace: await loadDeckWorkspace(oxyUserId) };
}
