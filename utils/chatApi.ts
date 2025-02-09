import axios from 'axios';
import { getData } from './storage';

const chatApi = axios.create({
  baseURL: process.env.API_URL,
  withCredentials: true
});

chatApi.interceptors.request.use(async (config) => {
  const accessToken = await getData('accessToken');
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
}, error => Promise.reject(error));

export const conversationApi = {
  checkConversation: (participantId: string) =>
    chatApi.post('/conversations/check', { participantId }),
  createConversation: async (data: { participants: string[]; type: string; name?: string }) => {
    try {
      const response = await chatApi.post('/conversations/create', data);
      return response.data;
    } catch (error) {
      console.error('Error creating conversation:', error);
      throw error;
    }
  },
  getAllConversations: () =>
    chatApi.get('/conversations/all'),
};

export const messageApi = {
  sendMessage: (data: { conversationId: string; content: string; type?: string }) =>
    chatApi.post('/messages/send', data),
  sendSecureMessage: (data: { conversationId: string; content: string }) =>
    chatApi.post('/messages/send-secure', data),
  editMessage: (data: { messageId: string; content: string }) =>
    chatApi.put('/messages/edit', data),
  deleteMessage: (messageId: string) =>
    chatApi.delete(`/messages/${messageId}`),
  markAsRead: (messageId: string) =>
    chatApi.put(`/messages/${messageId}/read`),
  pinMessage: (messageId: string) =>
    chatApi.put(`/messages/${messageId}/pin`),
  addReaction: (data: { messageId: string; type: string }) =>
    chatApi.post('/messages/reaction', data),
  createPoll: (data: { conversationId: string; question: string; options: string[] }) =>
    chatApi.post('/messages/poll', data),
  votePoll: (data: { messageId: string; optionIndex: number }) =>
    chatApi.post('/messages/poll/vote', data),
};
