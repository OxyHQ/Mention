/**
 * A post's reply controls (threadgate) and quote controls (postgate).
 *
 * Both are the POST's settings, so they follow the post's own two gates:
 *
 *  - reading one is an action on the post, so it asks the read gate
 *    (`canRequestReadPost`) and an unreadable post answers exactly as a post with
 *    no gate — the response cannot confirm a hidden post exists, nor name who
 *    manages it;
 *  - writing or removing one is managing the post, so it asks the same authority
 *    every post-settings route asks (`postManagementRefusal`).
 *
 * The gate is stored under the post's OWN URI (its author's), never one minted
 * from the caller's id: two managers of a channel post edit one gate, and a row
 * another account wrote against the same post id is never read back as the
 * author's.
 */

import type { OxyAuthRequest } from '@oxy.so/core/server';
import { createPostUri } from '@mention/shared-types';
import {
  deletePostgate,
  deleteThreadgate,
  loadPostgateByPostUri,
  loadThreadgateByPostUri,
  parseDetachedQuoteUris,
  parseThreadgateAllowRules,
  upsertPostgate,
  upsertThreadgate,
  type PostgateRecord,
  type ThreadgateRecord,
} from '../db/gates/gateRepository';
import { loadPostRecord } from '../db/posts/postRepository';
import { callerAccountAccess } from '../utils/oxyHelpers';
import { postManagementRefusal } from './postManagementAccess';
import { canRequestReadPost } from './postReadAccess';

/** What a gate route answers: a status and its JSON body. */
export interface GateResponse {
  status: number;
  body: unknown;
}

type GateKind = 'threadgate' | 'postgate';

const NOT_FOUND: Record<GateKind, GateResponse> = {
  threadgate: { status: 404, body: { message: 'Threadgate not found' } },
  postgate: { status: 404, body: { message: 'Postgate not found' } },
};

/** The post's own gate URI, or `null` when the post has no local author to own one. */
async function gateUriFor(postId: string): Promise<string | null> {
  const post = await loadPostRecord(postId);
  return post?.oxyUserId ? createPostUri(post.oxyUserId, post.id) : null;
}

async function readGate<T>(
  req: OxyAuthRequest,
  postId: string,
  kind: GateKind,
  load: (postUri: string) => Promise<T | null>,
): Promise<GateResponse> {
  if (!(await canRequestReadPost(req, postId))) return NOT_FOUND[kind];
  const postUri = await gateUriFor(postId);
  const gate = postUri ? await load(postUri) : null;
  return gate ? { status: 200, body: gate } : NOT_FOUND[kind];
}

/** The caller may manage the post: its gate URI. Otherwise the refusal to answer with. */
async function authorizeGateWrite(
  req: OxyAuthRequest,
  postId: string,
): Promise<{ postUri: string; callerId: string } | GateResponse> {
  const callerId = req.user?.id;
  if (!callerId) return { status: 401, body: { message: 'Unauthorized' } };
  const post = await loadPostRecord(postId);
  if (!post?.oxyUserId) return { status: 404, body: { message: 'Post not found' } };
  const refusal = await postManagementRefusal({
    post,
    callerId,
    accountAccess: callerAccountAccess(req),
  });
  if (refusal) return { status: refusal.status, body: { message: refusal.message } };
  return { postUri: createPostUri(post.oxyUserId, post.id), callerId };
}

export function readThreadgate(req: OxyAuthRequest, postId: string): Promise<GateResponse> {
  return readGate<ThreadgateRecord>(req, postId, 'threadgate', loadThreadgateByPostUri);
}

export function readPostgate(req: OxyAuthRequest, postId: string): Promise<GateResponse> {
  return readGate<PostgateRecord>(req, postId, 'postgate', loadPostgateByPostUri);
}

export async function writeThreadgate(
  req: OxyAuthRequest,
  postId: string,
  body: { allow?: unknown } | undefined,
): Promise<GateResponse> {
  const access = await authorizeGateWrite(req, postId);
  if ('status' in access) return access;
  // `allow[]` is validated here because the rules table refuses a `listOnly`
  // rule with no list and a list on any other rule. Rejecting the payload here
  // answers 400 instead of letting a CHECK violation surface as a 500.
  const allow = parseThreadgateAllowRules(body?.allow);
  if (!allow) return { status: 400, body: { message: 'Invalid threadgate allow rules' } };
  const gate = await upsertThreadgate({
    postUri: access.postUri,
    postId,
    createdBy: access.callerId,
    allow,
  });
  return { status: 200, body: gate };
}

export async function writePostgate(
  req: OxyAuthRequest,
  postId: string,
  body: { disableQuotes?: unknown; detachedQuoteUris?: unknown } | undefined,
): Promise<GateResponse> {
  const access = await authorizeGateWrite(req, postId);
  if ('status' in access) return access;
  const disableQuotes = body?.disableQuotes;
  if (disableQuotes !== undefined && disableQuotes !== null && typeof disableQuotes !== 'boolean') {
    return { status: 400, body: { message: 'disableQuotes must be a boolean' } };
  }
  const uris = parseDetachedQuoteUris(body?.detachedQuoteUris);
  if (!uris) {
    return { status: 400, body: { message: 'detachedQuoteUris must be an array of strings' } };
  }
  const gate = await upsertPostgate({
    postUri: access.postUri,
    postId,
    createdBy: access.callerId,
    disableQuotes: disableQuotes ?? false,
    detachedQuoteUris: uris,
  });
  return { status: 200, body: gate };
}

export async function removeThreadgate(req: OxyAuthRequest, postId: string): Promise<GateResponse> {
  const access = await authorizeGateWrite(req, postId);
  if ('status' in access) return access;
  const gate = await loadThreadgateByPostUri(access.postUri);
  if (!gate) return NOT_FOUND.threadgate;
  await deleteThreadgate(gate.id);
  return { status: 200, body: { message: 'Threadgate removed' } };
}

export async function removePostgate(req: OxyAuthRequest, postId: string): Promise<GateResponse> {
  const access = await authorizeGateWrite(req, postId);
  if ('status' in access) return access;
  const gate = await loadPostgateByPostUri(access.postUri);
  if (!gate) return NOT_FOUND.postgate;
  await deletePostgate(gate.id);
  return { status: 200, body: { message: 'Postgate removed' } };
}
