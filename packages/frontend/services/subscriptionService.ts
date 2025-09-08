import { authenticatedClient } from '../utils/api';

class SubscriptionService {
  async getStatus(authorId: string): Promise<{ subscribed: boolean }> {
    const resp = await authenticatedClient.get(`/subscriptions/${authorId}/status`);
    return resp.data;
  }

  async subscribe(authorId: string): Promise<{ subscribed: boolean }> {
    const resp = await authenticatedClient.post(`/subscriptions/${authorId}`);
    return resp.data;
  }

  async unsubscribe(authorId: string): Promise<{ subscribed: boolean }> {
    const resp = await authenticatedClient.delete(`/subscriptions/${authorId}`);
    return resp.data;
  }
}

export const subscriptionService = new SubscriptionService();
