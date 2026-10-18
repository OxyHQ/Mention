import type {
  DeckWorkspaceResponse,
  DeckWorkspaceState,
  DeckWorkspaceUpdate,
} from '@mention/shared-types/deck';
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

/** Compare-and-swap: competing devices never silently replace one another's edits. */
export async function saveDeckWorkspace(
  oxyUserId: string,
  update: DeckWorkspaceUpdate,
): Promise<{ saved: boolean; workspace: DeckWorkspaceResponse }> {
  const { baseRevision, state } = update;
  const db = getDb();
  let rows: DeckWorkspaceResponse[];
  if (baseRevision === 0) {
    // Disabling sync must not publish the device's local navigation/configuration.
    const initialState: DeckWorkspaceState = state.syncEnabled
      ? state
      : { syncEnabled: false, panels: {}, order: [] };
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
        state: state.syncEnabled
          ? state
          : sql`jsonb_set(${deckWorkspaces.state}, '{syncEnabled}', 'false'::jsonb)`,
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
