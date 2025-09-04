import { authenticatedClient } from '../utils/api';

export interface CreatePollRequest {
  question: string;
  options: string[];
  postId?: string; // optional during creation, but we will pass when known
  endsAt?: string; // ISO string
  isMultipleChoice?: boolean;
  isAnonymous?: boolean;
}

export const pollService = {
  async getPoll(pollId: string): Promise<{ success: boolean; data: any }> {
    const response = await authenticatedClient.get(`/polls/${pollId}`);
    return { success: true, data: response.data?.data ?? response.data };
  },

  async getResults(pollId: string): Promise<{ success: boolean; data: any }> {
    const response = await authenticatedClient.get(`/polls/${pollId}/results`);
    return { success: true, data: response.data?.data ?? response.data };
  },
  async createPoll(req: CreatePollRequest): Promise<{ success: boolean; data: any }> {
    const response = await authenticatedClient.post('/polls', req);
    return { success: true, data: response.data?.data ?? response.data };
  },

  async updatePollPostId(pollId: string, postId: string): Promise<{ success: boolean; data: any }> {
    const response = await authenticatedClient.post(`/polls/${pollId}/update-post`, { postId });
    return { success: true, data: response.data?.data ?? response.data };
  },

  async vote(pollId: string, optionId: string): Promise<{ success: boolean; data: any }> {
    const response = await authenticatedClient.post(`/polls/${pollId}/vote`, { optionId });
    return { success: true, data: response.data?.data ?? response.data };
  },
};

export default pollService;
