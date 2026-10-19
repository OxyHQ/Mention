import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeckWorkspaceState } from '@mention/shared-types/deck';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { deckWorkspaces } from '../../db/schema/deck';
import { ERASURE_STEPS } from '../../services/accountErasure/erasureSteps';
import deckRoutes from '../../routes/deck.routes';

const users: string[] = [];
function user() {
  const id = `deck-test-${randomUUID()}`;
  users.push(id);
  return id;
}
function state(): DeckWorkspaceState {
  return {
    syncEnabled: true,
    panels: {
      first: {
        source: 'explore',
        width: 390,
        resizable: true,
        appearance: 'solid',
        navigation: {
          entries: [
            { key: 'a', name: '/explore' },
            { key: 'b', name: '/t/Bloom', params: { name: 'Bloom' } },
          ],
          index: 1,
        },
        scrollOffsets: { [encodeURIComponent('first:b\0feed')]: 841 },
      },
    },
    order: ['first'],
    activePanel: 'first',
  };
}
function navigation(value: DeckWorkspaceState) {
  const result = value.panels.first.navigation;
  if (!result) throw new Error('Fixture requires navigation');
  return result;
}
const app = express();
app.use(express.json({ limit: '1mb' }));
// App mounts deckRoutes under its authenticated router. This fixture supplies
// an already-authenticated principal; neither URL nor body controls ownership.
app.use((req, res, next) => {
  const id = req.header('x-test-user');
  if (!id) {
    res.sendStatus(401);
    return;
  }
  Object.assign(req, { user: { id } });
  next();
});
app.use('/deck', deckRoutes);
const read = (id: string) => request(app).get('/deck').set('x-test-user', id);
const write = (id: string, baseRevision: number, value = state()) =>
  request(app).put('/deck').set('x-test-user', id).send({ baseRevision, state: value });

beforeAll(async () => {
  await connectPostgres();
});
afterAll(async () => {
  if (users.length)
    await getDb().delete(deckWorkspaces).where(inArray(deckWorkspaces.oxyUserId, users));
  await closePostgres();
});

describe('private Deck workspace persistence', () => {
  it('round trips the optional desktop home preference and preserves it on sync opt-out', async () => {
    const owner = user();
    const value = { ...state(), homeScreen: true };
    await write(owner, 0, value).expect(200);
    expect((await read(owner)).body.state).toEqual(value);
    await write(owner, 1, { ...value, syncEnabled: false, homeScreen: false }).expect(200);
    expect((await read(owner)).body.state).toEqual({ ...value, syncEnabled: false });
  });
  it('rejects nonboolean home preferences', async () => {
    await request(app)
      .put('/deck')
      .set('x-test-user', user())
      .send({ baseRevision: 0, state: { ...state(), homeScreen: 'true' } })
      .expect(400);
  });
  it('requires auth and returns absence without inventing layout defaults', async () => {
    await request(app).get('/deck').expect(401);
    const result = await read(user()).expect(200);
    expect(result.body).toEqual({ revision: 0, state: null });
    expect(result.headers['cache-control']).toBe('private, no-store');
  });
  it('round trips layout, route history, selected route and scroll only to its owner', async () => {
    const owner = user();
    const other = user();
    await write(owner, 0).expect(200);
    expect((await read(owner)).body).toEqual({ revision: 1, state: state() });
    expect((await read(other)).body).toEqual({ revision: 0, state: null });
    const edited = state();
    edited.panels.first.width = 500;
    await write(other, 0, edited).expect(200);
    expect((await read(owner)).body.state.panels.first.width).toBe(390);
  });
  it('allows exactly one concurrent first write and returns the winner on conflict', async () => {
    const owner = user();
    const alternate = state();
    alternate.panels.first.width = 500;
    const results = await Promise.all([write(owner, 0), write(owner, 0, alternate)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body).toEqual(
      results.find((r) => r.status === 200)?.body,
    );
  });
  it('rejects concurrent stale revisions without overwriting the winner', async () => {
    const owner = user();
    await write(owner, 0).expect(200);
    const alternate = state();
    alternate.panels.first.width = 500;
    const results = await Promise.all([write(owner, 1), write(owner, 1, alternate)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const latest = (await read(owner)).body;
    expect(latest.revision).toBe(2);
    expect(results.find((r) => r.status === 409)?.body).toEqual(latest);
    expect((await write(owner, 0)).body).toEqual(latest);
  });
  it('does not resurrect a missing row from a stale revision', async () => {
    const owner = user();
    expect((await write(owner, 3).expect(409)).body).toEqual({ revision: 0, state: null });
  });
  it('disabling sync changes only preference; reenabling publishes the local snapshot', async () => {
    const owner = user();
    await write(owner, 0).expect(200);
    const local = state();
    local.syncEnabled = false;
    local.panels.first.width = 600;
    const disabled = (await write(owner, 1, local).expect(200)).body;
    expect(disabled.state).toEqual({ ...state(), syncEnabled: false });
    local.syncEnabled = true;
    expect((await write(owner, 2, local).expect(200)).body.state).toEqual(local);
  });
  it('disabling before any sync stores no local panel or history data', async () => {
    const local = state();
    local.syncEnabled = false;
    expect((await write(user(), 0, local).expect(200)).body.state).toEqual({
      syncEnabled: false,
      panels: {},
      order: [],
    });
  });
  it('account erasure deletes only its owners document and is idempotent', async () => {
    const owner = user();
    const other = user();
    await write(owner, 0);
    await write(other, 0);
    const step = ERASURE_STEPS['deck_workspaces.oxyUserId'];
    expect(await step.apply({ oxyUserId: owner })).toBe(1);
    expect(await step.apply({ oxyUserId: owner })).toBe(0);
    expect((await read(owner)).body.state).toBeNull();
    expect((await read(other)).body.state).toEqual(state());
  });
  it.each([
    [
      'external route',
      (s: DeckWorkspaceState) => {
        navigation(s).entries[0].name = 'https://evil.test';
      },
    ],
    [
      'protocol relative route',
      (s: DeckWorkspaceState) => {
        navigation(s).entries[0].name = '//evil.test';
      },
    ],
    [
      'encoded route escape',
      (s: DeckWorkspaceState) => {
        navigation(s).entries[0].name = '/%5cevil.test';
      },
    ],
    [
      'invalid history index',
      (s: DeckWorkspaceState) => {
        navigation(s).index = 3;
      },
    ],
    [
      'duplicate route keys',
      (s: DeckWorkspaceState) => {
        navigation(s).entries[1].key = 'a';
      },
    ],
    [
      'invalid width',
      (s: DeckWorkspaceState) => {
        s.panels.first.width = 1_000_000;
      },
    ],
    [
      'negative scroll',
      (s: DeckWorkspaceState) => {
        s.panels.first.scrollOffsets = { a: -1 };
      },
    ],
    [
      'missing order panel',
      (s: DeckWorkspaceState) => {
        s.order = ['missing'];
      },
    ],
    [
      'duplicate order panel',
      (s: DeckWorkspaceState) => {
        s.order = ['first', 'first'];
      },
    ],
    [
      'unknown selection',
      (s: DeckWorkspaceState) => {
        s.activePanel = 'missing';
      },
    ],
  ])('rejects %s without creating state', async (_label, change) => {
    const owner = user();
    const invalid = state();
    change(invalid);
    await write(owner, 0, invalid).expect(400);
    expect((await read(owner)).body.state).toBeNull();
  });
  it.each(['panels', 'history', 'offsets', 'nul', 'surrogate'] as const)(
    'rejects excessive or malformed %s',
    async (kind) => {
      const value = state();
      if (kind === 'panels') {
        value.panels = Object.fromEntries(
          Array.from({ length: 25 }, (_, index) => [`p${index}`, value.panels.first]),
        );
        value.order = Object.keys(value.panels);
        delete value.activePanel;
      } else if (kind === 'history') {
        navigation(value).entries = Array.from({ length: 101 }, (_, index) => ({
          key: `h${index}`,
          name: '/explore',
        }));
      } else if (kind === 'offsets') {
        value.panels.first.scrollOffsets = Object.fromEntries(
          Array.from({ length: 257 }, (_, index) => [`s${index}`, index]),
        );
      } else {
        navigation(value).entries[0].params = { query: kind === 'nul' ? '\0' : '\ud800' };
      }
      await write(user(), 0, value).expect(400);
    },
  );

  it('round trips long encoded Bloom offset keys but rejects raw NUL and oversized keys', async () => {
    const owner = user();
    const value = state();
    const key = `${encodeURIComponent('first:b\0feed:')}${'x'.repeat(4000)}`;
    value.panels.first.scrollOffsets = { [key]: 1234 };
    await write(owner, 0, value).expect(200);
    expect((await read(owner)).body.state.panels.first.scrollOffsets).toEqual({ [key]: 1234 });
    for (const invalid of ['first:b\0feed', 'x'.repeat(4097)]) {
      value.panels.first.scrollOffsets = { [invalid]: 1234 };
      await write(owner, 1, value).expect(400);
    }
    expect((await read(owner)).body.revision).toBe(1);
  });

  it('rejects content objects, owner spoofing and excessive payloads', async () => {
    const owner = user();
    await request(app)
      .put('/deck')
      .set('x-test-user', owner)
      .send({ baseRevision: 0, state: state(), oxyUserId: user() })
      .expect(400);
    const invalid = state();
    Object.assign(navigation(invalid).entries[0], {
      params: { post: { body: 'private content' } },
    });
    await write(owner, 0, invalid).expect(400);
    await request(app)
      .put('/deck')
      .set('x-test-user', owner)
      .send({ baseRevision: 0, state: state(), content: 'x'.repeat(524_288) })
      .expect(413);
  });
});
