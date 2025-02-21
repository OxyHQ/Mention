import { postData } from '@/utils/api';
import { Platform } from 'react-native';

interface PaymentMethod {
  type: 'card' | 'applePay' | 'googlePay';
  cardNumber?: string;
  expiryMonth?: string;
  expiryYear?: string;
  cvc?: string;
  token?: string;
}

interface PaymentResponse {
  success: boolean;
  transactionId?: string;
  error?: string;
}

class PaymentService {
  async processPayment(userId: string, plan: string, paymentMethod: PaymentMethod): Promise<PaymentResponse> {
    try {
      let paymentData = {
        userId,
        plan,
        paymentMethod,
        platform: Platform.OS,
      };

      const response = await postData('/payments/process', paymentData);
      return response;
    } catch (error) {
      throw error;
    }
  }

  async validatePaymentMethod(paymentMethod: PaymentMethod): Promise<boolean> {
    try {
      const response = await postData('/payments/validate', { paymentMethod });
      return response.valid;
    } catch (error) {
      throw error;
    }
  }

  async getPaymentMethods(userId: string) {
    try {
      const response = await postData('/payments/methods', { userId });
      return response.methods;
    } catch (error) {
      throw error;
    }
  }
}

export const paymentService = new PaymentService();