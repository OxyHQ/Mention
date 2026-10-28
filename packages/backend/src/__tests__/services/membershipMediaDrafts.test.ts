import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  membershipCommunities,
  membershipContents,
  membershipMedia,
} from '../../db/schema/memberships';
import { oxyFileReferenceSync } from '../../db/schema/oxyFiles';
import { fileReferenceEntity, pairKey } from '../../db/oxyFiles/fileReferenceEntities';
import { expireMembershipMediaDrafts } from '../../services/memberships/mediaDrafts';

beforeAll(connectPostgres);
afterAll(closePostgres);
const old = () => new Date(Date.now() - 25 * 60 * 60 * 1000);
async function fixture() {
  const id = randomUUID();
  await getDb()
    .insert(membershipCommunities)
    .values({
      id,
      ownerOxyUserId: 'draft-owner',
      slug: `draft-${id}`,
      name: 'Draft expiry',
      description: '',
    });
  const [content] = await getDb()
    .insert(membershipContents)
    .values({ communityId: id, authorOxyUserId: 'draft-owner', kind: 'post', body: 'Protected' })
    .returning();
  if (!content) throw new Error('Missing content fixture');
  return { communityId: id, contentId: content.id };
}
async function media(
  communityId: string,
  options: { contentId?: string; fileId?: string; expired?: boolean } = {},
) {
  const [row] = await getDb()
    .insert(membershipMedia)
    .values({
      communityId,
      contentId: options.contentId,
      ownerOxyUserId: 'draft-owner',
      fileId: options.fileId ?? randomUUID(),
      mime: 'image/png',
      size: 4,
      createdAt: options.expired ? old() : new Date(),
    })
    .returning();
  if (!row) throw new Error('Missing media fixture');
  return row;
}
async function ownConnection() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Missing isolated database URL');
  return postgres(url, { max: 1, onnotice: () => undefined });
}
async function waitForBlocked(queryPrefix: string) {
  const observer = await ownConnection();
  try {
    await vi.waitFor(
      async () => {
        const [row] = await observer<
          { waiting: number }[]
        >`select count(*)::int as waiting from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike ${`${queryPrefix}%`}`;
        expect(row?.waiting).toBeGreaterThan(0);
      },
      { timeout: 10000, interval: 10 },
    );
  } finally {
    await observer.end();
  }
}
function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('expired unattached membership uploads', () => {
  it('expires old drafts only and releases their reference without touching a shared copy', async () => {
    const f = await fixture();
    const fileId = randomUUID();
    const expired = await media(f.communityId, { fileId, expired: true });
    const fresh = await media(f.communityId, { fileId });
    const attached = await media(f.communityId, { fileId, expired: true, contentId: f.contentId });
    const [before] = await getDb()
      .update(oxyFileReferenceSync)
      .set({ state: 'synced', syncedOp: 'add' })
      .where(eq(oxyFileReferenceSync.entityId, expired.id))
      .returning();
    if (!before) throw new Error('Missing upload reference');
    expect(await expireMembershipMediaDrafts()).toBe(1);
    const rows = await getDb()
      .select()
      .from(membershipMedia)
      .where(eq(membershipMedia.communityId, f.communityId));
    expect(rows.map((row) => row.id).sort()).toEqual([fresh.id, attached.id].sort());
    const entity = fileReferenceEntity('membership_media');
    if (!entity) throw new Error('Missing reference owner');
    const pairs = [
      { fileId, entityId: expired.id },
      { fileId, entityId: fresh.id },
    ];
    expect(await entity.pairsInUse(getDb(), pairs)).toEqual(new Set([pairKey(fileId, fresh.id)]));
    expect(await entity.filesInUse(getDb(), [fileId])).toEqual(new Set([fileId]));
    const [mark] = await getDb()
      .select()
      .from(oxyFileReferenceSync)
      .where(eq(oxyFileReferenceSync.entityId, expired.id));
    expect(mark?.state).toBe('pending');
    expect(mark?.generation).toBeGreaterThan(before.generation);
  });

  it('rechecks NULL after a concurrent attachment wins its row lock', async () => {
    const f = await fixture();
    const draft = await media(f.communityId, { expired: true });
    const sql = await ownConnection();
    const held = latch();
    const release = latch();
    const attaching = sql.begin(async (tx) => {
      await tx`update membership_media set content_id=${f.contentId} where id=${draft.id}`;
      held.release();
      await release.promise;
    });
    await held.promise;
    const expiring = expireMembershipMediaDrafts();
    try {
      await waitForBlocked('delete from "membership_media"');
    } finally {
      release.release();
    }
    await attaching;
    expect(await expiring).toBe(0);
    await sql.end();
    const [row] = await getDb()
      .select()
      .from(membershipMedia)
      .where(eq(membershipMedia.id, draft.id));
    expect(row?.contentId).toBe(f.contentId);
  });

  it('does not let an attachment reclaim a draft after expiry wins', async () => {
    const f = await fixture();
    const draft = await media(f.communityId, { expired: true });
    const held = latch();
    const release = latch();
    const expiring = getDb().transaction(async (tx) => {
      expect(await expireMembershipMediaDrafts(tx)).toBe(1);
      held.release();
      await release.promise;
    });
    await held.promise;
    const attaching = getDb()
      .update(membershipMedia)
      .set({ contentId: f.contentId })
      .where(eq(membershipMedia.id, draft.id))
      .returning()
      .execute();
    try {
      await waitForBlocked('update "membership_media"');
    } finally {
      release.release();
    }
    await expiring;
    expect(await attaching).toEqual([]);
  });

  it('walks more than one bounded batch', async () => {
    const f = await fixture();
    await getDb()
      .insert(membershipMedia)
      .values(
        Array.from({ length: 501 }, () => ({
          communityId: f.communityId,
          ownerOxyUserId: 'draft-owner',
          fileId: randomUUID(),
          mime: 'image/png',
          size: 4,
          createdAt: old(),
        })),
      );
    expect(await expireMembershipMediaDrafts()).toBe(501);
    expect(
      await getDb()
        .select()
        .from(membershipMedia)
        .where(eq(membershipMedia.communityId, f.communityId)),
    ).toEqual([]);
  });
});
