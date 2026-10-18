import type { DeckWorkspaceResponse } from '@mention/shared-types/deck';
import { normalizeDeckSnapshot, boundDeckSnapshot } from './deckValidation';
import { useDeckSettings, emptySnapshot, type DeckCache, type DeckSnapshot } from './deckSettings';
import { mergeDeckChanges, deckEqual } from './deckPersistence';
export type DeckResponse = DeckWorkspaceResponse;
export interface DeckTransport {
  load(signal: AbortSignal): Promise<DeckResponse>;
  save(revision: number, state: DeckSnapshot, signal: AbortSignal): Promise<DeckResponse>;
}
/** One serial writer per mounted viewer; cancellation fences every response. */
export function startDeckSync(viewer: string, transport: DeckTransport) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let loaded = false;
  let retry = 0;
  const current = () => !controller.signal.aborted && useDeckSettings.getState().viewer === viewer;
  const cache = () => useDeckSettings.getState().records[viewer];
  const status = (value: 'loading' | 'saving' | 'saved' | 'error' | 'local') =>
    useDeckSettings.getState().setStatus(viewer, value);
  const schedule = (delay = 400) => {
    clearTimeout(timer);
    if (current()) timer = setTimeout(run, delay);
  };
  const reconcile = (remote: DeckResponse, sent?: DeckCache) => {
    const latest = cache();
    if (!latest) return;
    const remoteState = remote.state === null ? null : normalizeDeckSnapshot(remote.state);
    if (remote.state !== null && !remoteState) throw new Error('Invalid Deck response');
    const base = sent?.state ?? latest.base ?? emptySnapshot();
    const state =
      remoteState == null
        ? latest.state
        : latest.dirty && base
          ? mergeDeckChanges(base, latest.state, remoteState)
          : latest.dirty
            ? latest.state
            : remoteState;
    // A disabled account keeps its device workspace; only the preference is shared.
    state.order = [...new Set([...state.order, ...Object.keys(state.panels)])].filter(
      (id) => id in state.panels,
    );
    if (state.activePanel && !state.panels[state.activePanel]) state.activePanel = state.order[0];
    const next = boundDeckSnapshot(
      !state.syncEnabled ? { ...latest.state, syncEnabled: false } : state,
    );
    if (!sent && !latest.dirty && remoteState?.syncEnabled)
      useDeckSettings.getState().restoreScope();
    useDeckSettings.getState().receive(viewer, {
      state: next,
      base: remoteState,
      revision: remote.revision,
      dirty:
        remote.state === null ||
        (next.syncEnabled ? !deckEqual(next, remoteState) : remote.state.syncEnabled !== false),
    });
  };
  async function run() {
    if (!current() || busy) return;
    busy = true;
    try {
      if (!loaded) {
        status('loading');
        const remote = await transport.load(controller.signal);
        if (!current()) return;
        reconcile(remote);
        loaded = true;
      }
      const pending = cache();
      if (pending?.dirty && (pending.state.syncEnabled || pending.base?.syncEnabled !== false)) {
        status('saving');
        const sent = pending;
        try {
          const outgoing = sent.state.syncEnabled
            ? sent.state
            : { syncEnabled: false, panels: {}, order: [] };
          const remote = await transport.save(sent.revision, outgoing, controller.signal);
          if (!current()) return;
          reconcile(remote, sent);
        } catch (error) {
          const conflict = error as { response?: { status?: number; data?: DeckResponse } };
          if (
            current() &&
            conflict.response?.status === 409 &&
            conflict.response.data &&
            'revision' in conflict.response.data
          ) {
            reconcile(conflict.response.data);
            schedule(0);
            return;
          }
          throw error;
        }
      }
      if (!current()) return;
      retry = 0;
      const latest = cache();
      status(!latest?.state.syncEnabled ? 'local' : latest.dirty ? 'saving' : 'saved');
      if (latest?.dirty && (latest.state.syncEnabled || latest.base?.syncEnabled !== false))
        schedule();
    } catch {
      if (!current()) return;
      status('error');
      schedule(Math.min(30_000, 1000 * 2 ** Math.min(retry++, 5)));
    } finally {
      busy = false;
    }
  }
  const unsubscribe = useDeckSettings.subscribe((state, previous) => {
    if (state.records[viewer] !== previous.records[viewer] && !busy && state.records[viewer]?.dirty)
      schedule();
  });
  void run();
  return {
    retry: () => schedule(0),
    stop: () => {
      controller.abort();
      clearTimeout(timer);
      unsubscribe();
    },
  };
}
