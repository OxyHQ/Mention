import axios from 'axios';
import { getData } from './storage';

const api = axios.create({
  baseURL: 'http://localhost:3000/api',
  headers: {
    'Content-Type': 'application/json'
  }
});

api.interceptors.request.use(async (config) => {
  const accessToken = await getData('accessToken');
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
}, error => Promise.reject(error));

export const conversationApi = {
  checkConversation: (participantId: string) =>
    api.post('/conversations/check', { participantId }),
  createConversation: (data: { participants: string[]; type: string; name?: string }) =>
    api.post('/conversations/create', data),
  getAllConversations: () =>
    api.get('/conversations/all'),
};

export const messageApi = {
  sendMessage: (data: { conversationId: string; content: string; type?: string }) =>
    api.post('/messages/send', data),
  sendSecureMessage: (data: { conversationId: string; content: string }) =>
    api.post('/messages/send-secure', data),
  editMessage: (data: { messageId: string; content: string }) =>
    api.put('/messages/edit', data),
  deleteMessage: (messageId: string) =>
    api.delete(`/messages/${messageId}`),
  markAsRead: (messageId: string) =>
    api.put(`/messages/${messageId}/read`),
  pinMessage: (messageId: string) =>
    api.put(`/messages/${messageId}/pin`),
  addReaction: (data: { messageId: string; type: string }) =>
    api.post('/messages/reaction', data),
  createPoll: (data: { conversationId: string; question: string; options: string[] }) =>
    api.post('/messages/poll', data),
  votePoll: (data: { messageId: string; optionIndex: number }) =>
    api.post('/messages/poll/vote', data),
};