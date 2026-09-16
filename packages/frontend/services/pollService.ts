import { authenticatedClient } from '../utils/api';
import type { PollDetail, PollResults } from '@mention/shared-types';

export type { PollDetail, PollDetailOption, PollResults, PollResultOption } from '@mention/shared-types';

export interface CreatePollRequest {
  question: string;
  options: string[];
  postId?: string; // optional during creation, but we will pass when known
  endsAt?: string; // ISO string
  isMultipleChoice?: boolean;
  isAnonymous?: boolean;
}

/** Every `/polls/*` response is `{ success, data }` — no route answers raw. */
interface Envelope<T> {
  success: boolean;
  data: T;
}

function isEnvelope(value: unknown): value is Envelope<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    'data' in value
  );
}

/** Thrown when a `/polls/*` response does not match the shape this client expects. */
export class PollContractError extends Error {}

function isPollDetail(value: unknown): value is PollDetail {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PollDetail>;
  return (
    typeof candidate._id === 'string' &&
    typeof candidate.question === 'string' &&
    Array.isArray(candidate.options) &&
    Array.isArray(candidate.viewerSelectedOptionIds)
  );
}

function isPollResults(value: unknown): value is PollResults {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PollResults>;
  return (
    typeof candidate.id === 'string' &&
    Array.isArray(candidate.results) &&
    typeof candidate.totalVotes === 'number'
  );
}

/**
 * Unwraps a `/polls/*` response into a typed, validated {@link PollDetail}.
 *
 * Every check here is deliberate: the envelope shape and the poll shape are
 * verified separately, and neither is accepted via an unchecked cast — a
 * malformed or unexpectedly-shaped response becomes a {@link PollContractError}
 * here, at the one seam between the API and every consumer, rather than a
 * `TypeError` thrown later from inside a render.
 */
async function unwrapPollDetail(
  request: Promise<{ data: unknown }>,
): Promise<{ success: boolean; data: PollDetail }> {
  const response = await request;
  const body = response.data;
  if (!isEnvelope(body)) {
    throw new PollContractError('Poll response is missing the {success, data} envelope');
  }
  if (!isPollDetail(body.data)) {
    throw new PollContractError('Poll response data is not a valid poll');
  }
  return { success: body.success, data: body.data };
}

async function unwrapPollResults(
  request: Promise<{ data: unknown }>,
): Promise<{ success: boolean; data: PollResults }> {
  const response = await request;
  const body = response.data;
  if (!isEnvelope(body)) {
    throw new PollContractError('Poll results response is missing the {success, data} envelope');
  }
  if (!isPollResults(body.data)) {
    throw new PollContractError('Poll results response data is not valid poll results');
  }
  return { success: body.success, data: body.data };
}

export const pollService = {
  async getPoll(pollId: string): Promise<{ success: boolean; data: PollDetail }> {
    return unwrapPollDetail(authenticatedClient.get<unknown>(`/polls/${pollId}`));
  },

  async getResults(pollId: string): Promise<{ success: boolean; data: PollResults }> {
    return unwrapPollResults(authenticatedClient.get<unknown>(`/polls/${pollId}/results`));
  },

  async createPoll(req: CreatePollRequest): Promise<{ success: boolean; data: PollDetail }> {
    return unwrapPollDetail(authenticatedClient.post<unknown>('/polls', req));
  },

  async updatePollPostId(pollId: string, postId: string): Promise<{ success: boolean; data: PollDetail }> {
    return unwrapPollDetail(authenticatedClient.post<unknown>(`/polls/${pollId}/update-post`, { postId }));
  },

  async vote(pollId: string, optionId: string): Promise<{ success: boolean; data: PollDetail }> {
    return unwrapPollDetail(authenticatedClient.post<unknown>(`/polls/${pollId}/vote`, { optionId }));
  },
};
