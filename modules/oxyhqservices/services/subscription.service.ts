import { fetchData, postData, deleteData } from '@/utils/api';

class SubscriptionService {
  async getSubscription(userId: string) {
    try {
      return await fetchData(`/subscriptions/${userId}`);
    } catch (error) {
      throw error;
    }
  }

  async updateSubscription(userId: string, plan: "basic" | "pro" | "business") {
    try {
      return await postData(`/subscriptions/${userId}`, { plan });
    } catch (error) {
      throw error;
    }
  }

  async cancelSubscription(userId: string) {
    try {
      return await deleteData(`/subscriptions/${userId}`);
    } catch (error) {
      throw error;
    }
  }
}

export const subscriptionService = new SubscriptionService();