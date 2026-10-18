import { DECK_LIMITS } from '@mention/shared-types/deck';
import { loadDeckWorkspace, saveDeckWorkspace } from '../../db/deck/deckWorkspaceRepository';
import { deckWorkspaceUpdateSchema } from './deckWorkspaceValidation';

export const deckWorkspaceService = {
  load: (ownerId: string) => loadDeckWorkspace(ownerId),
  async update(ownerId: string, body: unknown) {
    if (Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8') > DECK_LIMITS.payloadBytes) {
      return { status: 413, body: { error: 'Deck workspace is too large' } };
    }
    const parsed = deckWorkspaceUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return {
        status: 400,
        body: { error: 'Invalid Deck workspace', issues: parsed.error.issues },
      };
    }
    const result = await saveDeckWorkspace(ownerId, parsed.data);
    return { status: result.saved ? 200 : 409, body: result.workspace };
  },
};
