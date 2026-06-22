import { authenticatedClient } from '../utils/api';

export interface CreatePollRequest {
  question: string;
  options: string[];
  postId?: string; // optional during creation, but we will pass when known
  endsAt?: string; // ISO string
  isMultipleChoice?: boolean;
  isAnonymous?: boolean;
}

export interface PollOption {
  _id: string;
  text: string;
  votes: string[]; // User IDs who voted for this option
}

export interface PollData {
  _id: string;
  question: string;
  options: PollOption[];
  postId?: string;
  createdBy?: string;
  endsAt?: string;
  isMultipleChoice?: boolean;
  isAnonymous?: boolean;
  totalVotes?: number;
  created_at?: string;
  updated_at?: string;
}

/** Backend poll endpoints wrap the poll under `data`, but some return it raw. */
interface PollEnvelope {
  data?: PollData;
}

async function unwrap(request: Promise<{ data: PollData | PollEnvelope }>): Promise<{ success: boolean; data: PollData }> {
  const response = await request;
  const body = response.data;
  const poll = (body as PollEnvelope).data ?? (body as PollData);
  return { success: true, data: poll };
}

export const pollService = {
  async getPoll(pollId: string): Promise<{ success: boolean; data: PollData }> {
    return unwrap(authenticatedClient.get<PollData | PollEnvelope>(`/polls/${pollId}`));
  },

  async getResults(pollId: string): Promise<{ success: boolean; data: PollData }> {
    return unwrap(authenticatedClient.get<PollData | PollEnvelope>(`/polls/${pollId}/results`));
  },

  async createPoll(req: CreatePollRequest): Promise<{ success: boolean; data: PollData }> {
    return unwrap(authenticatedClient.post<PollData | PollEnvelope>('/polls', req));
  },

  async updatePollPostId(pollId: string, postId: string): Promise<{ success: boolean; data: PollData }> {
    return unwrap(authenticatedClient.post<PollData | PollEnvelope>(`/polls/${pollId}/update-post`, { postId }));
  },

  async vote(pollId: string, optionId: string): Promise<{ success: boolean; data: PollData }> {
    return unwrap(authenticatedClient.post<PollData | PollEnvelope>(`/polls/${pollId}/vote`, { optionId }));
  },
};
