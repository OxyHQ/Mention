/**
 * Oxy's file events (ADR 0041 D9/D10), against REAL rows: the signed route and
 * what an event does to the posts, GIFs and banners that use the file.
 *
 * Every event names a file this file created, so the shared database is safe.
 */

import { createHmac, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FileEvent } from '@oxy.so/core/server';
import { PostType, PostVisibility } from '@mention/shared-types';
import { config } from '../../../config';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import {
  deletePostRecord,
  findPostRecords,
  insertPostRecord,
} from '../../../db/posts/postRepository';
import { posts } from '../../../db/schema/posts';
import { gifs } from '../../../db/schema/discovery';
import { oxyFileEvents, oxyFileReferenceSync, oxyFileStates } from '../../../db/schema/oxyFiles';
import { postMedia, postVariantMedia } from '../../../db/schema/postContent';
import { userSettings } from '../../../db/schema/userProfile';
import { createOxyFileEventsRoutes } from '../../../routes/oxyFileEvents.routes';
import { applyFileEvent, withholdingFor } from '../../../services/oxyFiles/fileEvents';
import { resolveMediaItems } from '../../../utils/mediaResolver';

const AUTHOR = 'oxy-file-events-author';
const SECRET = 'whsec_test_0123456789abcdef';
const fid = (label: string) => `ofe-${label}-${randomUUID().slice(0, 8)}`;

let minutes = 0;
/** A distinct, increasing instant per event. */
function at(): string {
  minutes += 1;
  return new Date(Date.UTC(2026, 9, 16, 12, minutes)).toISOString();
}

function event(
  fileId: string,
  type: FileEvent['type'],
  file: Partial<FileEvent['file']> = {},
  occurredAt = at(),
): FileEvent {
  return {
    id: `evt_${randomUUID()}`,
    type,
    occurredAt,
    file: { id: fileId, ownerKind: 'account', visibility: 'public', status: 'active', ...file },
    references: [],
  };
}

async function post(fileId: string): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.IMAGE,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: {
      variants: [
        { source: 'author', text: 'events', tag: 'en', media: [{ id: fileId, type: 'image' }] },
      ],
      media: [{ id: fileId, type: 'image' }],
    },
  });
  return record.id;
}

async function withheldOf(postId: string, fileId: string) {
  const [shared] = await getDb()
    .select({ withheld: postMedia.withheld })
    .from(postMedia)
    .where(eq(postMedia.postId, postId));
  const [override] = await getDb()
    .select({ withheld: postVariantMedia.withheld })
    .from(postVariantMedia)
    .where(eq(postVariantMedia.mediaId, fileId));
  return [shared?.withheld ?? null, override?.withheld ?? null];
}

function sign(body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function app() {
  const server = express();
  server.use('/webhooks', createOxyFileEventsRoutes());
  return server;
}

const mutableConfig = config.oxyFiles as { webhookSecret?: string; webhookPreviousSecret?: string };

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  mutableConfig.webhookSecret = SECRET;
  mutableConfig.webhookPreviousSecret = undefined;
});

afterAll(async () => {
  await closePostgres();
});

describe('POST /webhooks/oxy/files', () => {
  it('echoes the endpoint challenge, even before a secret is configured', async () => {
    mutableConfig.webhookSecret = undefined;
    await request(app())
      .post('/webhooks/oxy/files')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'webhook.challenge', challenge: 'abc123' }))
      .expect(200, { challenge: 'abc123' });
  });

  it('refuses events with 503 (Oxy retries) until a secret is configured', async () => {
    mutableConfig.webhookSecret = undefined;
    const body = JSON.stringify(event(fid('nosecret'), 'file.deleted', { status: 'deleted' }));
    await request(app())
      .post('/webhooks/oxy/files')
      .set('Content-Type', 'application/json')
      .set('oxy-signature', sign(body))
      .send(body)
      .expect(503);
  });

  it('refuses a wrong signature with 401 and changes nothing', async () => {
    const file = fid('forged');
    const body = JSON.stringify(event(file, 'file.blocked', { status: 'blocked' }));
    await request(app())
      .post('/webhooks/oxy/files')
      .set('Content-Type', 'application/json')
      .set('oxy-signature', sign(body, 'whsec_someone_else_000000'))
      .send(body)
      .expect(401);
    const rows = await getDb().select().from(oxyFileStates).where(eq(oxyFileStates.fileId, file));
    expect(rows).toEqual([]);
  });

  it('applies a correctly signed event (the previous secret too, during a rotation)', async () => {
    mutableConfig.webhookSecret = 'whsec_new_secret_0000000000';
    mutableConfig.webhookPreviousSecret = SECRET;
    const file = fid('signed');
    const id = await post(file);
    const body = JSON.stringify(event(file, 'file.blocked', { status: 'blocked' }));
    await request(app())
      .post('/webhooks/oxy/files')
      .set('Content-Type', 'application/json')
      .set('oxy-signature', sign(body))
      .send(body)
      .expect(204);
    expect(await withheldOf(id, file)).toEqual(['blocked', 'blocked']);
    await deletePostRecord(id);
  });
});

describe('what an event does', () => {
  it('maps every reported state to a withholding', () => {
    const file = { id: 'f', ownerKind: 'account' as const, visibility: 'public' as const };
    expect(withholdingFor({ ...file, status: 'deleted' })).toBe('deleted');
    expect(withholdingFor({ ...file, status: 'blocked' })).toBe('blocked');
    expect(withholdingFor({ ...file, status: 'trash' })).toBe('trashed');
    expect(withholdingFor({ ...file, status: 'active', visibility: 'private' })).toBe('private');
    expect(withholdingFor({ ...file, status: 'active', visibility: 'unlisted' })).toBeNull();
    expect(withholdingFor({ ...file, status: 'something-new' })).toBeUndefined();
  });

  it('withholds a taken-down file from every post, and serves it again when Oxy lifts it', async () => {
    const file = fid('takedown');
    const id = await post(file);

    const blocked = await applyFileEvent(event(file, 'file.blocked', { status: 'blocked' }));
    expect(blocked).toMatchObject({ applied: true, withheld: 'blocked', mediaRowsChanged: 2 });
    expect(await withheldOf(id, file)).toEqual(['blocked', 'blocked']);

    // The DTO drops it; the stored row (and its reference) stays.
    const [record] = await findPostRecords(eq(posts.id, id), { orderBy: [] });
    expect(record.content.media?.[0]).toMatchObject({ id: file, withheld: 'blocked' });
    expect(resolveMediaItems(record.content.media)).toEqual([]);
    const [mark] = await getDb()
      .select({ fileId: oxyFileReferenceSync.fileId })
      .from(oxyFileReferenceSync)
      .where(eq(oxyFileReferenceSync.fileId, file));
    expect(mark).toBeDefined();

    const lifted = await applyFileEvent(event(file, 'file.unblocked', { status: 'active' }));
    expect(lifted).toMatchObject({ applied: true, withheld: null, mediaRowsChanged: 2 });
    expect(await withheldOf(id, file)).toEqual([null, null]);
    const [state] = await getDb()
      .select()
      .from(oxyFileStates)
      .where(eq(oxyFileStates.fileId, file));
    expect(state.expiresAt).not.toBeNull();
    await deletePostRecord(id);
  });

  it('withholds a file its owner trashed or made private, until they bring it back', async () => {
    const file = fid('owner');
    const id = await post(file);
    await applyFileEvent(event(file, 'file.trashed', { status: 'trash' }));
    expect(await withheldOf(id, file)).toEqual(['trashed', 'trashed']);
    await applyFileEvent(event(file, 'file.restored', { status: 'active', visibility: 'private' }));
    expect(await withheldOf(id, file)).toEqual(['private', 'private']);
    await applyFileEvent(event(file, 'file.visibility_changed', { visibility: 'public' }));
    expect(await withheldOf(id, file)).toEqual([null, null]);
    await deletePostRecord(id);
  });

  it('ignores an event older than the one applied, and a redelivery', async () => {
    const file = fid('order');
    const id = await post(file);
    const early = at();
    const late = at();
    const blocked = event(file, 'file.blocked', { status: 'blocked' }, late);
    await applyFileEvent(blocked);

    const older = await applyFileEvent(event(file, 'file.unblocked', { status: 'active' }, early));
    expect(older).toMatchObject({ applied: false, withheld: 'blocked' });
    expect(await withheldOf(id, file)).toEqual(['blocked', 'blocked']);

    expect(await applyFileEvent(blocked)).toMatchObject({ duplicate: true, applied: false });
    const events = await getDb()
      .select({ applied: oxyFileEvents.applied })
      .from(oxyFileEvents)
      .where(eq(oxyFileEvents.fileId, file));
    expect(events.map((row) => row.applied).sort()).toEqual([false, true]);
    await deletePostRecord(id);
  });

  it('never releases a deleted file', async () => {
    const file = fid('deleted');
    const id = await post(file);
    await applyFileEvent(event(file, 'file.deleted', { status: 'deleted' }));
    const after = await applyFileEvent(event(file, 'file.restored', { status: 'active' }));
    expect(after.applied).toBe(false);
    expect(await withheldOf(id, file)).toEqual(['deleted', 'deleted']);
    await deletePostRecord(id);
  });

  it('removes the GIF row and clears a banner that use a blocked file, with the counts audited', async () => {
    const file = fid('gif-blocked');
    const user = fid('user');
    await getDb()
      .insert(gifs)
      .values({
        klipyId: fid('klipy'),
        width: 10,
        height: 10,
        mp4FileId: file,
        previewFileId: file,
        storage: 'application',
      });
    await getDb().insert(userSettings).values({ oxyUserId: user, profileHeaderImage: file });

    const blocked = event(file, 'file.blocked', { status: 'blocked', ownerKind: 'application' });
    const outcome = await applyFileEvent(blocked);

    expect(outcome).toMatchObject({ gifsRemoved: 1, bannersCleared: 1 });
    expect(await getDb().select().from(gifs).where(eq(gifs.mp4FileId, file))).toEqual([]);
    const [settings] = await getDb()
      .select({ banner: userSettings.profileHeaderImage })
      .from(userSettings)
      .where(eq(userSettings.oxyUserId, user));
    expect(settings.banner).toBeNull();
    const [audit] = await getDb()
      .select()
      .from(oxyFileEvents)
      .where(eq(oxyFileEvents.eventId, blocked.id));
    expect(audit).toMatchObject({
      applied: true,
      withheld: 'blocked',
      gifsRemoved: 1,
      bannersCleared: 1,
      type: 'file.blocked',
      ownerKind: 'application',
    });
    await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, user));
  });

  it("re-sends the references of Mention's own file Oxy put in trash (restoring it)", async () => {
    const file = fid('gif-trash');
    const [gif] = await getDb()
      .insert(gifs)
      .values({
        klipyId: fid('klipy'),
        width: 10,
        height: 10,
        mp4FileId: file,
        previewFileId: file,
        storage: 'application',
      })
      .returning({ id: gifs.id });
    await getDb()
      .update(oxyFileReferenceSync)
      .set({ state: 'synced', syncedOp: 'add' })
      .where(eq(oxyFileReferenceSync.fileId, file));

    const outcome = await applyFileEvent(
      event(file, 'file.trashed', { status: 'trash', ownerKind: 'application' }),
    );

    expect(outcome).toMatchObject({ withheld: 'trashed', referencesResent: 1, gifsRemoved: 0 });
    const [mark] = await getDb()
      .select()
      .from(oxyFileReferenceSync)
      .where(inArray(oxyFileReferenceSync.fileId, [file]));
    expect(mark).toMatchObject({
      entityType: 'gif',
      entityId: gif.id,
      state: 'pending',
      syncedOp: null,
    });
    await getDb().delete(gifs).where(eq(gifs.id, gif.id));
  });
});
