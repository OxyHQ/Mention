import { randomUUID } from 'node:crypto';
import { applyFileEvent } from '../../services/oxyFiles/fileEvents';
import { oxyFileStates, oxyFileEvents, oxyFileReferenceSync } from '../../db/schema/oxyFiles';
import { fileReferenceEntity, pairKey } from '../../db/oxyFiles/fileReferenceEntities';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import type { AccountMember, AccountNode } from '@oxy.so/core';
import type { RequestSafetyContext } from '../../utils/safetyRequester';

const state = vi.hoisted(() => ({
  viewer: 'membership-owner' as string | undefined,
  proof: 'session' as 'session' | 'mcp' | 'service' | 'capability',
  members: [] as AccountMember[],
  accounts: [] as AccountNode[],
  fileVisibility: 'private',
  files: true,
  linkedVisibility: 'private' as string | undefined,
  blockedAuthors: [] as string[],
  safetyUnavailable: false,
  safety: vi.fn(),
  memberReadDenied: false,
  withRequester: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
}));
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: async (ids: string[]) =>
    new Map(ids.map((id) => [id, { user: { id, kind: 'organization', name: {} } }])),
}));
vi.mock('../../utils/oxyHelpers', () => ({
  createUserScopedOxyServices: () => ({
    accounts: {
      list: async () => state.accounts,
      members: {
        list: async () => {
          if (state.memberReadDenied) throw new Error('Oxy denied members:read');
          return state.members;
        },
      },
    },
  }),
  getServiceOxyClient: () => ({
    safety: {
      contentAccessBatch: async (
        input: { items: { resourceId: string; authorAccountId?: string }[] },
        requester: unknown,
      ) => {
        state.safety(input, requester);
        if (state.safetyUnavailable) throw new Error('Safety unavailable');
        return {
          items: input.items.map((item) => ({
            resourceId: item.resourceId,
            decision: {
              allowed: !state.blockedAuthors.includes(item.authorAccountId ?? ''),
              reason: state.blockedAuthors.includes(item.authorAccountId ?? '')
                ? 'blocked'
                : 'allowed',
              policyVersion: '2',
            },
          })),
        };
      },
    },
    assets: {
      withRequester: (proof: unknown) => {
        state.withRequester(proof);
        return {
          uploadAppFile: async (...args: unknown[]) => {
            state.upload(...args);
            return {
              file: {
                id: 'private-oxy-file',
                mime: 'image/png',
                size: 8,
                visibility: state.fileVisibility,
                ownerApplicationId: 'mention-application',
              },
              deduplicated: false,
            };
          },
          linkedDownloadUrls: async (ids: string[]) => {
            state.download(ids);
            return state.files
              ? [
                  {
                    id: 'private-oxy-file',
                    url: 'https://files.example/signed',
                    expiresIn: 300,
                    visibility: state.linkedVisibility,
                  },
                ]
              : [];
          },
        };
      },
    },
  }),
}));
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import {
  communityMemberships,
  membershipCommunities,
  membershipContents,
  membershipMedia,
  membershipTiers,
} from '../../db/schema/memberships';
import { posts } from '../../db/schema/posts';
import { membershipRoutes, publicMembershipRoutes } from '../../routes/memberships';
import { membershipGrantsAccess } from '../../services/memberships/access';

const app = express();
app.use(express.json());
app.use((req: express.Request & RequestSafetyContext, _res, next) => {
  if (state.viewer) {
    req.user = { id: state.viewer };
    req.accessToken = `session-${state.viewer}`;
  }
  if (state.proof === 'mcp') {
    req.mcp = { activeUserId: state.viewer };
    req.headers.authorization = 'Bearer test-mcp';
  }
  if (state.proof === 'service') {
    req.serviceApp = { authority: 'first_party' };
    req.serviceActingAs = {
      authority: 'first_party',
      userId: state.viewer ?? '',
      requesterContext: 'verified-test-context',
    };
  }
  if (state.proof === 'capability')
    req.capability = { ticket: 'task', claims: { resource: { effectiveAccountId: state.viewer } } };
  next();
});
app.use('/membership-communities', publicMembershipRoutes, membershipRoutes);
const base = '/membership-communities';
let serial = 0;
beforeAll(connectPostgres);
beforeEach(async () => {
  state.viewer = 'membership-owner';
  state.proof = 'session';
  state.members = [];
  state.accounts = [];
  state.fileVisibility = 'private';
  state.files = true;
  state.linkedVisibility = 'private';
  await getDb().delete(oxyFileStates).where(eq(oxyFileStates.fileId, 'private-oxy-file'));
  await getDb().delete(oxyFileEvents).where(eq(oxyFileEvents.fileId, 'private-oxy-file'));
  await getDb()
    .delete(oxyFileReferenceSync)
    .where(eq(oxyFileReferenceSync.fileId, 'private-oxy-file'));
  state.blockedAuthors = [];
  state.safetyUnavailable = false;
  state.memberReadDenied = false;
  vi.clearAllMocks();
  await getDb()
    .delete(membershipCommunities)
    .where(like(membershipCommunities.slug, 'membershiptest-%'));
});
afterAll(async () => {
  await getDb()
    .delete(membershipCommunities)
    .where(like(membershipCommunities.slug, 'membershiptest-%'));
  await closePostgres();
});
async function community() {
  state.viewer = 'membership-owner';
  const created = await request(app)
    .post(base)
    .send({ ownerOxyUserId: state.viewer, name: 'Members', slug: `membershiptest-${++serial}` });
  expect(created.status).toBe(201);
  const id = created.body.data.id as string;
  expect((await request(app).patch(`${base}/${id}`).send({ status: 'active' })).status).toBe(200);
  const landing = await request(app).get(`${base}/${id}/landing`);
  return { id, tierId: landing.body.data.tiers[0].id as string };
}
async function join(c: { id: string; tierId: string }, viewer = 'membership-member') {
  state.viewer = viewer;
  const result = await request(app).put(`${base}/${c.id}/membership`).send({ tierId: c.tierId });
  expect(result.status).toBe(200);
  return result.body.data;
}
async function content(communityId: string, extra: Record<string, unknown> = {}) {
  state.viewer = 'membership-owner';
  const result = await request(app)
    .post(`${base}/${communityId}/content`)
    .send({
      kind: 'post',
      body: 'Hidden membership body',
      teaser: 'Explicit public teaser',
      ...extra,
    });
  expect(result.status).toBe(201);
  return result.body.data;
}

describe('membership domain HTTP and PostgreSQL authority', () => {
  it('keeps bodies and media out of public teasers and nonmembers', async () => {
    const c = await community();
    const post = await content(c.id);
    state.viewer = undefined;
    const teaser = await request(app).get(`${base}/content/${post.id}/teaser`);
    expect(teaser.status).toBe(200);
    expect(teaser.body.data.teaser).toBe('Explicit public teaser');
    expect(JSON.stringify(teaser.body)).not.toContain('Hidden membership body');
    expect(teaser.body.data).not.toHaveProperty('body');
    expect(teaser.body.data).not.toHaveProperty('media');
    expect((await request(app).get(`${base}/content/${post.id}`)).status).toBe(401);
    state.viewer = 'outsider';
    expect((await request(app).get(`${base}/content/${post.id}`)).status).toBe(403);
    await join(c);
    const allowed = await request(app).get(`${base}/content/${post.id}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.body).toBe('Hidden membership body');
    expect(allowed.headers['cache-control']).toBe('private, no-store');
    expect(await getDb().select().from(posts).where(eq(posts.id, post.id))).toEqual([]);
  });
  it('removes access immediately on leave and prevents revoked members rejoining', async () => {
    const c = await community();
    const post = await content(c.id);
    await join(c);
    expect((await request(app).delete(`${base}/${c.id}/membership`)).status).toBe(200);
    expect((await request(app).get(`${base}/content/${post.id}`)).status).toBe(403);
    await join(c);
    state.viewer = 'membership-owner';
    expect((await request(app).delete(`${base}/${c.id}/members/membership-member`)).status).toBe(
      200,
    );
    state.viewer = 'membership-member';
    await request(app).delete(`${base}/${c.id}/membership`);
    expect(
      (await request(app).put(`${base}/${c.id}/membership`).send({ tierId: c.tierId })).status,
    ).toBe(403);
    expect((await request(app).get(`${base}/content/${post.id}`)).status).toBe(403);
  });
  it.each(['mcp', 'service', 'capability'] as const)(
    'refuses unrelated %s authority even for an active member',
    async (proof) => {
      const c = await community();
      const post = await content(c.id);
      await join(c);
      state.proof = proof;
      expect((await request(app).get(`${base}/content/${post.id}`)).status).toBe(403);
      expect(
        (await request(app).put(`${base}/${c.id}/membership`).send({ tierId: c.tierId })).status,
      ).toBe(403);
      const publicResult = await request(app).get(`${base}/${c.id}/landing`);
      expect(publicResult.body.data.membership).toBeNull();
      expect(publicResult.body.data.canManage).toBe(false);
    },
  );
  it('requires account authority, not an arbitrary owner id or ordinary member', async () => {
    const c = await community();
    await join(c);
    expect((await request(app).patch(`${base}/${c.id}`).send({ name: 'Hijacked' })).status).toBe(
      403,
    );
    expect(
      (
        await request(app).post(base).send({
          ownerOxyUserId: 'other-account',
          name: 'Hijacked',
          slug: 'membershiptest-hijacked',
        })
      ).status,
    ).toBe(403);
  });
  it('lists operated communities only with current Oxy account authority', async () => {
    const c = await community();
    state.viewer = 'membership-member';
    const member: AccountMember = {
      _id: 'operator-row',
      accountId: 'membership-owner',
      memberUserId: 'membership-member',
      role: 'admin',
      permissions: ['account:act_as'],
      inherit: true,
      status: 'active',
      source: 'direct',
      createdAt: '',
      updatedAt: '',
    };
    state.accounts = [
      {
        accountId: 'membership-owner',
        kind: 'organization',
        parentAccountId: null,
        relationship: 'member',
        callerMembership: member,
        account: { id: 'membership-owner', publicKey: 'test-key', username: 'owner', name: {} },
      },
    ];
    expect(
      (await request(app).get(`${base}/mine`)).body.data.owned.map((row: { id: string }) => row.id),
    ).toEqual([c.id]);
    state.accounts[0].callerMembership = { ...member, permissions: [] };
    expect((await request(app).get(`${base}/mine`)).body.data.owned).toEqual([]);
    state.accounts[0].callerMembership = { ...member, status: 'removed' };
    expect((await request(app).get(`${base}/mine`)).body.data.owned).toEqual([]);
  });

  it('keeps member identity private until explicit badge consent and clears it on leave', async () => {
    const c = await community();
    await join(c);
    expect((await request(app).get(`${base}/${c.id}/directory`)).body.data).toEqual([]);
    await request(app).patch(`${base}/${c.id}/membership`).send({ publicBadge: true });
    expect((await request(app).get(`${base}/${c.id}/directory`)).body.data).toEqual([
      { oxyUserId: 'membership-member' },
    ]);
    await request(app).delete(`${base}/${c.id}/membership`);
    expect((await request(app).get(`${base}/${c.id}/directory`)).body.data).toEqual([]);
  });
  it('lets members discuss while reserving publication and public teasers to operators', async () => {
    const c = await community();
    const post = await content(c.id);
    await join(c);
    expect(
      (await request(app).post(`${base}/${c.id}/content`).send({ kind: 'article', body: 'No' }))
        .status,
    ).toBe(403);
    const reply = await request(app)
      .post(`${base}/${c.id}/content`)
      .send({ kind: 'discussion', parentContentId: post.id, body: 'Private reply' });
    expect(reply.status).toBe(201);
    expect(reply.body.data.parentContentId).toBe(post.id);
    expect((await request(app).get(`${base}/content/${reply.body.data.id}/teaser`)).status).toBe(
      404,
    );
    expect(
      (
        await request(app)
          .post(`${base}/${c.id}/content`)
          .send({ kind: 'discussion', body: 'No', teaser: 'Public' })
      ).status,
    ).toBe(403);
  });
  it('updates a free tier atomically and applies its changed benefits to existing members', async () => {
    const c = await community();
    await join(c);
    state.viewer = 'membership-owner';
    const updated = await request(app)
      .patch(`${base}/${c.id}/tiers/${c.tierId}`)
      .send({ name: 'Readers', benefits: ['content_read'] });
    expect(updated.status).toBe(200);
    state.viewer = 'membership-member';
    expect((await request(app).get(`${base}/${c.id}/content`)).status).toBe(200);
    expect(
      (
        await request(app)
          .post(`${base}/${c.id}/content`)
          .send({ kind: 'discussion', body: 'Cannot write' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`${base}/${c.id}/tiers/${c.tierId}`)
          .send({ benefits: ['discussion_write'] })
      ).status,
    ).toBe(403);
    state.viewer = 'membership-owner';
    expect(
      (await request(app).patch(`${base}/${c.id}/tiers/${c.tierId}`).send({ benefits: [] })).status,
    ).toBe(400);
  });

  it('keeps paid tiers draft and refuses subscribing without billing configuration', async () => {
    const c = await community();
    const tier = await request(app)
      .post(`${base}/${c.id}/tiers`)
      .send({ name: 'Supporter', kind: 'paid', benefits: ['content_read'] });
    expect(tier.status).toBe(201);
    expect(tier.body.data.status).toBe('draft');
    expect(
      (
        await request(app)
          .patch(`${base}/${c.id}/tiers/${tier.body.data.id}`)
          .send({ status: 'active' })
      ).status,
    ).toBe(409);
    state.viewer = 'membership-member';
    expect(
      (await request(app).put(`${base}/${c.id}/membership`).send({ tierId: tier.body.data.id }))
        .status,
    ).toBe(409);
    expect(
      (await request(app).get(`${base}/${c.id}/landing`)).body.data.paidSubscriptionsAvailable,
    ).toBe(false);
  });
  it('excludes tier-restricted content from the page and refuses direct ids and thread replies', async () => {
    const c = await community();
    const tier = await request(app)
      .post(`${base}/${c.id}/tiers`)
      .send({ name: 'Future', kind: 'paid', benefits: ['content_read'] });
    const restricted = await content(c.id, { requiredTierIds: [tier.body.data.id] });
    const regular = await content(c.id);
    await join(c);
    const page = await request(app).get(`${base}/${c.id}/content`);
    expect(page.status).toBe(200);
    expect(page.body.data.items.map((item: { id: string }) => item.id)).toEqual([regular.id]);
    expect((await request(app).get(`${base}/content/${restricted.id}`)).status).toBe(403);
    expect(
      (
        await request(app)
          .post(`${base}/${c.id}/content`)
          .send({ kind: 'discussion', body: 'No', parentContentId: restricted.id })
      ).status,
    ).toBe(403);
  });
  it('isolates private poll selections between viewers while aggregating counts', async () => {
    const c = await community();
    const poll = await content(c.id, {
      kind: 'poll',
      poll: { options: ['First', 'Second'], endsAt: new Date(Date.now() + 60000).toISOString() },
    });
    await join(c, 'voter-a');
    expect(
      (
        await request(app)
          .put(`${base}/content/${poll.id}/vote`)
          .send({ optionId: poll.poll.options[0].id })
      ).status,
    ).toBe(200);
    await join(c, 'voter-b');
    const other = await request(app).get(`${base}/content/${poll.id}`);
    expect(other.body.data.poll.selectedOptionId).toBeNull();
    expect(other.body.data.poll.options[0].votes).toBe(1);
    const page = await request(app).get(`${base}/${c.id}/content`);
    expect(page.body.data.items[0].poll.selectedOptionId).toBeNull();
    state.viewer = 'voter-a';
    expect(
      (await request(app).get(`${base}/content/${poll.id}`)).body.data.poll.selectedOptionId,
    ).toBe(poll.poll.options[0].id);
  });
  it('uses original requester proof for private Files and rechecks membership before minting URLs', async () => {
    const c = await community();
    const uploaded = await request(app)
      .post(`${base}/${c.id}/media`)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('testpng'));
    expect(uploaded.status).toBe(201);
    expect(state.upload).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', {
      visibility: 'private',
    });
    const post = await content(c.id, { mediaIds: [uploaded.body.data.id] });
    await join(c);
    const mediaPath = `${base}/content/${post.id}/media/${uploaded.body.data.id}`;
    const download = await request(app).get(mediaPath);
    expect(download.status).toBe(200);
    expect(download.body.data.expiresIn).toBe(300);
    expect(state.withRequester).toHaveBeenLastCalledWith({
      requesterToken: 'session-membership-member',
    });
    await request(app).delete(`${base}/${c.id}/membership`);
    state.download.mockClear();
    expect((await request(app).get(mediaPath)).status).toBe(403);
    expect(state.download).not.toHaveBeenCalled();
  });
  it('rejects public deduplicated uploads and never attaches arbitrary file ids', async () => {
    const c = await community();
    state.fileVisibility = 'public';
    expect(
      (
        await request(app)
          .post(`${base}/${c.id}/media`)
          .set('Content-Type', 'image/png')
          .send(Buffer.from('public'))
      ).status,
    ).toBe(409);
    expect(
      await getDb().select().from(membershipMedia).where(eq(membershipMedia.communityId, c.id)),
    ).toEqual([]);
    expect(
      (
        await request(app)
          .post(`${base}/${c.id}/content`)
          .send({ kind: 'post', body: 'Bad media', mediaIds: ['foreign-file'] })
      ).status,
    ).toBe(400);
    expect(
      await getDb()
        .select()
        .from(membershipContents)
        .where(eq(membershipContents.communityId, c.id)),
    ).toEqual([]);
  });
  it('reports protected content without exposing the reporter to operators', async () => {
    const c = await community();
    const post = await content(c.id);
    await join(c);
    expect(
      (
        await request(app)
          .post(`${base}/content/${post.id}/reports`)
          .send({ reason: 'Please review' })
      ).status,
    ).toBe(201);
    expect((await request(app).get(`${base}/${c.id}/reports`)).status).toBe(403);
    state.viewer = 'membership-owner';
    const reports = await request(app).get(`${base}/${c.id}/reports`);
    expect(reports.body.data).toHaveLength(1);
    expect(JSON.stringify(reports.body)).not.toContain('membership-member');
    const reportId = reports.body.data[0].id;
    state.viewer = 'membership-member';
    expect((await request(app).post(`${base}/${c.id}/reports/${reportId}/resolve`)).status).toBe(
      403,
    );
    state.viewer = 'membership-owner';
    expect((await request(app).post(`${base}/${c.id}/reports/${reportId}/resolve`)).status).toBe(
      200,
    );
    expect((await request(app).get(`${base}/${c.id}/reports`)).body.data).toEqual([]);
    await request(app).delete(`${base}/content/${post.id}`);
    state.viewer = 'membership-member';
    expect((await request(app).get(`${base}/content/${post.id}`)).status).toBe(404);
  });
  it('bounds grace/period-end cancellation and rejects expired/refunded/revoked entitlements', async () => {
    const c = await community();
    await join(c);
    const [row] = await getDb()
      .select()
      .from(communityMemberships)
      .where(eq(communityMemberships.communityId, c.id));
    const now = new Date();
    const future = new Date(now.getTime() + 60000);
    expect(
      membershipGrantsAccess({ ...row, state: 'grace_period', accessEndsAt: future }, now),
    ).toBe(true);
    expect(membershipGrantsAccess({ ...row, state: 'cancelled', accessEndsAt: future }, now)).toBe(
      true,
    );
    expect(membershipGrantsAccess({ ...row, state: 'active', accessEndsAt: now }, now)).toBe(false);
    for (const state of ['expired', 'refunded', 'revoked'] as const)
      expect(membershipGrantsAccess({ ...row, state, accessEndsAt: future }, now)).toBe(false);
  });
  it('fails closed on canonical blocks/suspension and safety outages across metadata, content and reports', async () => {
    const c = await community();
    const post = await content(c.id);
    await join(c);
    state.blockedAuthors = ['membership-owner'];
    for (const path of [
      `${base}/${c.id}/landing`,
      `${base}/${c.id}/directory`,
      `${base}/content/${post.id}/teaser`,
      `${base}/content/${post.id}`,
    ]) {
      expect((await request(app).get(path)).status).toBe(404);
    }
    expect(
      (await request(app).post(`${base}/content/${post.id}/reports`).send({ reason: 'No' })).status,
    ).toBe(404);
    state.blockedAuthors = [];
    state.safetyUnavailable = true;
    expect((await request(app).get(`${base}/content/${post.id}`)).status).toBe(503);
  });
  it('does not require a community member to have the owner account members:read permission', async () => {
    const c = await community();
    const post = await content(c.id);
    await join(c);
    state.memberReadDenied = true;
    expect((await request(app).get(`${base}/content/${post.id}`)).status).toBe(200);
    const landing = await request(app).get(`${base}/${c.id}/landing`);
    expect(landing.status).toBe(200);
    expect(landing.body.data.canManage).toBe(false);
    expect((await request(app).patch(`${base}/${c.id}`).send({ name: 'No' })).status).toBe(403);
  });
  it('lets operators remove blocked authors without hydrating their body, and lets former members delete their own data', async () => {
    const c = await community();
    await join(c);
    const authored = await request(app)
      .post(`${base}/${c.id}/content`)
      .send({ kind: 'discussion', body: 'Private member discussion' });
    expect(authored.status).toBe(201);
    state.viewer = 'membership-owner';
    state.blockedAuthors = ['membership-member'];
    expect((await request(app).get(`${base}/content/${authored.body.data.id}`)).status).toBe(404);
    expect((await request(app).delete(`${base}/content/${authored.body.data.id}`)).status).toBe(
      200,
    );
    state.blockedAuthors = [];
    await join(c);
    const next = await request(app)
      .post(`${base}/${c.id}/content`)
      .send({ kind: 'discussion', body: 'Remove after leaving' });
    await request(app).delete(`${base}/${c.id}/membership`);
    expect((await request(app).delete(`${base}/content/${next.body.data.id}`)).status).toBe(200);
  });
  it('discards only the caller-owned unattached upload and retains attached content', async () => {
    const c = await community();
    const draft = await request(app)
      .post(`${base}/${c.id}/media`)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('draft'));
    expect(draft.status).toBe(201);
    await join(c);
    expect((await request(app).delete(`${base}/${c.id}/media/${draft.body.data.id}`)).status).toBe(
      404,
    );
    state.viewer = 'membership-owner';
    expect((await request(app).delete(`${base}/${c.id}/media/${draft.body.data.id}`)).status).toBe(
      200,
    );
    const upload = await request(app)
      .post(`${base}/${c.id}/media`)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('attached'));
    await content(c.id, { mediaIds: [upload.body.data.id] });
    expect((await request(app).delete(`${base}/${c.id}/media/${upload.body.data.id}`)).status).toBe(
      404,
    );
  });

  it('tracks private file references and enforces live visibility plus ordered lifecycle callbacks', async () => {
    const c = await community();
    const uploaded = await request(app)
      .post(`${base}/${c.id}/media`)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('private-lifecycle'));
    expect(uploaded.status).toBe(201);
    const mediaId = uploaded.body.data.id;
    const authored = await content(c.id, { mediaIds: [mediaId] });
    const path = `${base}/content/${authored.id}/media/${mediaId}`;
    const registry = fileReferenceEntity('membership_media');
    expect(
      await registry.pairsInUse(getDb(), [{ fileId: 'private-oxy-file', entityId: mediaId }]),
    ).toEqual(new Set([pairKey('private-oxy-file', mediaId)]));
    const dirty = await getDb()
      .select()
      .from(oxyFileReferenceSync)
      .where(eq(oxyFileReferenceSync.entityId, mediaId));
    expect(dirty).toHaveLength(1);
    expect(dirty[0]?.entityType).toBe('membership_media');
    for (const visibility of ['public', 'unlisted', undefined]) {
      state.linkedVisibility = visibility;
      expect((await request(app).get(path)).status).toBe(404);
    }
    state.linkedVisibility = 'private';
    expect((await request(app).get(path)).status).toBe(200);
    const emit = (visibility: 'public' | 'private', occurredAt: string) =>
      applyFileEvent({
        id: `evt_${randomUUID()}`,
        type: 'file.visibility_changed',
        occurredAt,
        file: { id: 'private-oxy-file', ownerKind: 'account', status: 'active', visibility },
        references: [{ entityType: 'membership_media', entityId: mediaId }],
      });
    await emit('private', '2026-10-28T10:00:00.000Z');
    expect((await request(app).get(path)).status).toBe(200);
    await emit('public', '2026-10-28T10:02:00.000Z');
    await emit('private', '2026-10-28T10:01:00.000Z');
    expect((await request(app).get(path)).status).toBe(404);
    expect((await request(app).get(`${base}/content/${authored.id}`)).body.data.media).toEqual([]);
    await emit('private', '2026-10-28T10:03:00.000Z');
    expect((await request(app).get(path)).status).toBe(200);
    await applyFileEvent({
      id: `evt_${randomUUID()}`,
      type: 'file.deleted',
      occurredAt: '2026-10-28T10:04:00.000Z',
      file: {
        id: 'private-oxy-file',
        ownerKind: 'account',
        visibility: 'private',
        status: 'deleted',
      },
      references: [{ entityType: 'membership_media', entityId: mediaId }],
    });
    await emit('private', '2026-10-28T10:05:00.000Z');
    expect((await request(app).get(path)).status).toBe(404);
    await getDb().delete(membershipCommunities).where(eq(membershipCommunities.id, c.id));
    expect(
      await registry.pairsInUse(getDb(), [{ fileId: 'private-oxy-file', entityId: mediaId }]),
    ).toEqual(new Set());
    const removed = await getDb()
      .select()
      .from(oxyFileReferenceSync)
      .where(eq(oxyFileReferenceSync.entityId, mediaId));
    expect(removed[0]?.generation).toBeGreaterThan(dirty[0]?.generation ?? 0);
  });

  it('keeps member-owned media private after its uploader leaves and respects Files revocation', async () => {
    const c = await community();
    await join(c);
    const uploaded = await request(app)
      .post(`${base}/${c.id}/media`)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('member-media'));
    expect(uploaded.status).toBe(201);
    const authored = await request(app)
      .post(`${base}/${c.id}/content`)
      .send({ kind: 'discussion', body: 'Private file', mediaIds: [uploaded.body.data.id] });
    const mediaPath = `${base}/content/${authored.body.data.id}/media/${uploaded.body.data.id}`;
    await request(app).delete(`${base}/${c.id}/membership`);
    expect((await request(app).get(mediaPath)).status).toBe(403);
    await join(c, 'another-member');
    expect((await request(app).get(mediaPath)).status).toBe(200);
    expect(state.withRequester).toHaveBeenLastCalledWith({
      requesterToken: 'session-another-member',
    });
    expect(state.upload).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', {
      visibility: 'private',
    });
    state.files = false;
    expect((await request(app).get(mediaPath)).status).toBe(404);
  });
  it('enforces paid activation and cross-community tier integrity in the database', async () => {
    const c = await community();
    const other = await community();
    await expect(
      getDb()
        .insert(communityMemberships)
        .values({ communityId: c.id, tierId: other.tierId, memberOxyUserId: 'outsider' }),
    ).rejects.toThrow();
    await expect(
      getDb()
        .insert(membershipTiers)
        .values({ communityId: c.id, name: 'Paid', kind: 'paid', status: 'active' }),
    ).rejects.toThrow();
    const [count] = await getDb().execute<{ count: string }>(
      sql`select count(*)::text as count from membership_contents where community_id = ${c.id}`,
    );
    expect(count.count).toBe('0');
  });
});
