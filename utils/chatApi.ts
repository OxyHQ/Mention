import axios from 'axios';
import { getData } from './storage';
import CryptoJS from 'crypto-js';
import { API_OXY_CHAT } from '@/config';
import { getChatSocket, initializeChatSocket, ChatSocket } from './chatSocket';
import { toast } from 'sonner';

// Chat types and interfaces
export type ChatType = 'private' | 'secret' | 'group' | 'channel';

interface ChatEncryption {
  encrypt: (text: string, key: string) => string;
  decrypt: (text: string, key: string) => string;
}

export interface ConversationData {
  participants: string[];
  type: ChatType;
  name?: string;
  isPublic?: boolean;
  description?: string;
  ttl?: number;
  encryptionKey?: string;
}

interface SocketResponse<T = any> {
  error?: string;
  success?: boolean;
  conversation?: T;
  message?: T;
}

// Initialize axios instance
const chatApi = axios.create({
  baseURL: API_OXY_CHAT,
  withCredentials: true,
  timeout: 10000
});

// Add auth token to requests
chatApi.interceptors.request.use(async (config) => {
  const accessToken = await getData('accessToken');
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
}, error => Promise.reject(error));

chatApi.interceptors.response.use(
  response => response,
  async (error) => {
    if (error.response?.status === 401) {
      // Handle unauthorized error
      toast.error('Session expired. Please log in again.');
    } else if (!error.response) {
      // Network error
      toast.error('Network error. Please check your connection.');
    } else {
      // Other errors
      toast.error(error.response?.data?.error?.message || 'An error occurred');
    }
    throw error;
  }
);

// Encryption utilities for secret chats
const encryption: ChatEncryption = {
  encrypt: (text: string, key: string) => {
    return CryptoJS.AES.encrypt(text, key).toString();
  },
  decrypt: (text: string, key: string) => {
    const bytes = CryptoJS.AES.decrypt(text, key);
    return bytes.toString(CryptoJS.enc.Utf8);
  }
};

// Ensure socket connection with retry mechanism
const ensureSocketConnection = async (): Promise<ChatSocket | null> => {
  const socket = await initializeChatSocket();
  if (!socket?.connected) {
    throw new Error('Could not establish socket connection');
  }
  return socket;
};

export const conversationApi = {
  // Check if conversation exists
  checkConversation: (participantId: string) =>
    chatApi.post('/chat/conversations/check', { participantId }),

  // Create different types of conversations
  createConversation: async (data: ConversationData) => {
    try {
      // Validate required fields
      if (!data.participants || data.participants.length === 0) {
        throw new Error('At least one participant is required');
      }

      if (!data.type || !['private', 'secret', 'group', 'channel'].includes(data.type)) {
        throw new Error('Invalid conversation type');
      }

      // Additional type-specific validation
      if ((data.type === 'group' || data.type === 'channel') && !data.name) {
        throw new Error(`Name is required for ${data.type}s`);
      }

      if (data.type === 'secret' && !data.ttl) {
        throw new Error('Message expiration time is required for secret chats');
      }

      // Generate encryption key for secret chats
      if (data.type === 'secret') {
        const encryptionKey = CryptoJS.lib.WordArray.random(256/8).toString();
        data = { ...data, encryptionKey };
      }
      
      // Initialize socket first to ensure connection is ready
      const socket = await initializeChatSocket();
      if (!socket) {
        throw new Error('Unable to establish socket connection');
      }

      // Create conversation via socket instead of REST
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Create conversation timeout'));
        }, 10000);

        socket.emit('createConversation', data, (response: SocketResponse) => {
          clearTimeout(timeout);
          if (response.error) {
            reject(new Error(response.error));
          } else if (response.conversation) {
            socket.emit('joinConversation', response.conversation._id);
            resolve(response.conversation);
          } else {
            reject(new Error('Invalid server response'));
          }
        });
      });
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to create conversation';
      toast.error(errorMessage);
      throw error;
    }
  },

  // Get all conversations
  getAllConversations: () => chatApi.get('/chat/conversations'),

  // Get single conversation
  getConversation: (id: string) => chatApi.get(`/chat/conversations/${id}`),

  // Channel specific operations
  channelOperations: {
    join: (channelId: string) => chatApi.post(`/chat/conversations/channel/${channelId}/join`),
    leave: (channelId: string) => chatApi.post(`/chat/conversations/channel/${channelId}/leave`),
    addAdmin: (channelId: string, userId: string) => 
      chatApi.post(`/chat/conversations/channel/${channelId}/admin`, { userId }),
    removeAdmin: (channelId: string, userId: string) => 
      chatApi.delete(`/chat/conversations/channel/${channelId}/admin/${userId}`),
    updatePermissions: (channelId: string, permissions: any) =>
      chatApi.put(`/chat/conversations/channel/${channelId}/permissions`, permissions),
  },

  // Group operations
  groupOperations: {
    addMember: (groupId: string, userId: string) => 
      chatApi.post(`/chat/conversations/group/${groupId}/member`, { userId }),
    removeMember: (groupId: string, userId: string) => 
      chatApi.delete(`/chat/conversations/group/${groupId}/member/${userId}`),
    makeAdmin: (groupId: string, userId: string) => 
      chatApi.post(`/chat/conversations/group/${groupId}/admin`, { userId }),
    updateSettings: (groupId: string, settings: any) =>
      chatApi.put(`/chat/conversations/group/${groupId}/settings`, settings),
  }
};

export const messageApi = {
  // Get messages for a conversation
  getMessages: (conversationId: string) => 
    chatApi.get(`/chat/messages/${conversationId}`),

  // Send regular message
  sendMessage: async (data: { 
    conversationId: string; 
    content: string; 
    type?: string;
    replyTo?: string;
  }) => {
    const socket = await ensureSocketConnection();
    if (!socket) {
      throw new Error('Socket connection not available');
    }
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Message send timeout'));
        toast.error('Message send timeout. Please try again.');
      }, 5000);

      socket.emit('sendMessage', data, (response: SocketResponse) => {
        clearTimeout(timeout);
        if (response.error) {
          toast.error(response.error);
          reject(new Error(response.error));
        } else {
          resolve(response.message);
        }
      });
    });
  },

  // Send encrypted message for secret chats
  sendSecureMessage: async (data: { 
    conversationId: string; 
    content: string;
    encryptionKey: string;
  }) => {
    await ensureSocketConnection();
    const socket = getChatSocket();
    const encryptedContent = encryption.encrypt(data.content, data.encryptionKey);
    
    return new Promise((resolve, reject) => {
      if (!socket?.connected) {
        toast.error('Not connected to chat server');
        reject(new Error('Socket connection not available'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Message send timeout'));
        toast.error('Message send timeout. Please try again.');
      }, 5000);

      socket.emit('sendSecureMessage', {
        conversationId: data.conversationId,
        content: encryptedContent
      }, (response: SocketResponse) => {
        clearTimeout(timeout);
        if (response.error) {
          toast.error(response.error);
          reject(new Error(response.error));
        } else {
          resolve(response.message);
        }
      });
    });
  },

  // Edit message
  editMessage: async (data: { messageId: string; content: string }) => {
    await ensureSocketConnection();
    const socket = getChatSocket();
    
    return new Promise((resolve, reject) => {
      if (!socket?.connected) {
        toast.error('Not connected to chat server');
        reject(new Error('Socket connection not available'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Edit timeout'));
        toast.error('Edit timeout. Please try again.');
      }, 5000);

      socket.emit('editMessage', data, (response: SocketResponse) => {
        clearTimeout(timeout);
        if (response.error) {
          toast.error(response.error);
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  },

  // Delete message
  deleteMessage: async (messageId: string) => {
    await ensureSocketConnection();
    const socket = getChatSocket();
    
    return new Promise((resolve, reject) => {
      if (!socket?.connected) {
        toast.error('Not connected to chat server');
        reject(new Error('Socket connection not available'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Delete timeout'));
        toast.error('Delete timeout. Please try again.');
      }, 5000);

      socket.emit('deleteMessage', { messageId }, (response: SocketResponse) => {
        clearTimeout(timeout);
        if (response.error) {
          toast.error(response.error);
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  },

  // Message status
  markAsRead: (messageId: string) =>
    chatApi.put(`/chat/messages/${messageId}/read`),

  // Pin/unpin message
  pinMessage: (messageId: string, pin: boolean = true) =>
    chatApi.put(`/chat/messages/${messageId}/pin`, { pin }),

  // Message reactions
  addReaction: async (data: { messageId: string; type: string }) => {
    await ensureSocketConnection();
    const socket = getChatSocket();
    
    return new Promise((resolve, reject) => {
      if (!socket?.connected) {
        toast.error('Not connected to chat server');
        reject(new Error('Socket connection not available'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Reaction timeout'));
        toast.error('Reaction timeout. Please try again.');
      }, 5000);

      socket.emit('reactionMessage', data, (response: SocketResponse) => {
        clearTimeout(timeout);
        if (response.error) {
          toast.error(response.error);
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  },

  removeReaction: (messageId: string, reactionId: string) =>
    chatApi.delete(`/chat/messages/${messageId}/reaction/${reactionId}`),

  // Polls
  createPoll: async (data: { 
    conversationId: string; 
    question: string; 
    options: string[];
    multipleChoice?: boolean;
  }) => {
    await ensureSocketConnection();
    const socket = getChatSocket();
    
    return new Promise((resolve, reject) => {
      if (!socket?.connected) {
        toast.error('Not connected to chat server');
        reject(new Error('Socket connection not available'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Poll creation timeout'));
        toast.error('Poll creation timeout. Please try again.');
      }, 5000);

      socket.emit('createPoll', data, (response: SocketResponse) => {
        clearTimeout(timeout);
        if (response.error) {
          toast.error(response.error);
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  },

  votePoll: async (data: { messageId: string; optionIndex: number }) => {
    await ensureSocketConnection();
    const socket = getChatSocket();
    
    return new Promise((resolve, reject) => {
      if (!socket?.connected) {
        toast.error('Not connected to chat server');
        reject(new Error('Socket connection not available'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Vote timeout'));
        toast.error('Vote timeout. Please try again.');
      }, 5000);

      socket.emit('votePoll', data, (response: SocketResponse) => {
        clearTimeout(timeout);
        if (response.error) {
          toast.error(response.error);
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  },

  // Forward message
  forwardMessage: (data: { 
    messageId: string; 
    toConversationId: string;
  }) => chatApi.post('/messages/forward', data),

  // Schedule message
  scheduleMessage: (data: { 
    conversationId: string; 
    content: string; 
    scheduledFor: Date;
  }) => chatApi.post('/messages/schedule', data),

  // Self-destructing messages for secret chats
  sendEphemeralMessage: (data: { 
    conversationId: string; 
    content: string; 
    ttl: number;
  }) => chatApi.post('/messages/ephemeral', data),
};
