import axios from 'axios';
import { getData } from './storage';
import CryptoJS from 'crypto-js';
import { API_OXY_CHAT } from '@/config';
import { getChatSocket, initializeChatSocket, ChatSocket } from './chatSocket';
import { toast } from 'sonner';
import { useTranslation } from "react-i18next";
import i18next from 'i18next';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { AuthBottomSheet } from '@/modules/oxyhqservices/components/AuthBottomSheet';
import { useContext } from 'react';
import { showAuthBottomSheet } from './auth';
import { fetchData, batchRequest, getCacheKey, setCacheEntry, clearCache } from './api';
import api from './api';

// Constants
const MESSAGE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CONVERSATION_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const SOCKET_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_ATTEMPTS = 3;

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
      showAuthBottomSheet();
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

// Socket connection management
let socketReconnectAttempts = 0;
let socketReconnectTimeout: NodeJS.Timeout | null = null;

const resetSocketReconnectAttempts = () => {
  socketReconnectAttempts = 0;
  if (socketReconnectTimeout) {
    clearTimeout(socketReconnectTimeout);
    socketReconnectTimeout = null;
  }
};

// Enhanced socket connection with retry mechanism
const ensureSocketConnection = async (): Promise<ChatSocket | null> => {
  try {
    const socket = await initializeChatSocket();
    if (socket?.connected) {
      resetSocketReconnectAttempts();
      return socket;
    }

    if (socketReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      throw new Error('Max reconnection attempts reached');
    }

    return new Promise((resolve, reject) => {
      socketReconnectAttempts++;
      socketReconnectTimeout = setTimeout(async () => {
        try {
          const newSocket = await initializeChatSocket();
          if (newSocket?.connected) {
            resetSocketReconnectAttempts();
            resolve(newSocket);
          } else {
            reject(new Error('Socket connection failed'));
          }
        } catch (error) {
          reject(error);
        }
      }, SOCKET_RECONNECT_DELAY * socketReconnectAttempts);
    });
  } catch (error) {
    console.error('Socket connection error:', error);
    throw error;
  }
};

export const conversationApi = {
  // Check if conversation exists with caching
  checkConversation: async (participantId: string) => {
    const cacheKey = getCacheKey(`conversations/check/${participantId}`);
    return fetchData(
      '/chat/conversations/check',
      {
        params: { participantId },
        cacheTTL: CONVERSATION_CACHE_TTL
      }
    );
  },

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
      
      const socket = await ensureSocketConnection();
      if (!socket) {
        throw new Error('Unable to establish socket connection');
      }

      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Create conversation timeout'));
        }, 10000);

        socket.emit('createConversation', data, (response: SocketResponse) => {
          clearTimeout(timeout);
          if (response.error) {
            reject(new Error(response.error));
          } else if (response.conversation) {
            socket.emit('joinConversation', response.conversation._id);
            // Clear conversation cache when creating new one
            clearCache('conversations');
            resolve(response.conversation);
          } else {
            reject(new Error('Invalid server response'));
          }
        });
      });

      return result;
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to create conversation';
      toast.error(errorMessage);
      throw error;
    }
  },

  // Get all conversations with caching
  getAllConversations: () => 
    fetchData('/chat/conversations', { cacheTTL: CONVERSATION_CACHE_TTL }),

  // Get single conversation with caching
  getConversation: (id: string) =>
    fetchData(`/chat/conversations/${id}`, { cacheTTL: CONVERSATION_CACHE_TTL }),

  // Channel specific operations with cache invalidation
  channelOperations: {
    join: async (channelId: string) => {
      const result = await api.post(`/chat/conversations/channel/${channelId}/join`);
      clearCache(`conversations/${channelId}`);
      return result.data;
    },
    
    leave: async (channelId: string) => {
      const result = await api.post(`/chat/conversations/channel/${channelId}/leave`);
      clearCache(`conversations/${channelId}`);
      return result.data;
    },
    
    addAdmin: async (channelId: string, userId: string) => {
      const result = await api.post(`/chat/conversations/channel/${channelId}/admin`, { userId });
      clearCache(`conversations/${channelId}`);
      return result.data;
    },
    
    removeAdmin: async (channelId: string, userId: string) => {
      const result = await api.delete(`/chat/conversations/channel/${channelId}/admin/${userId}`);
      clearCache(`conversations/${channelId}`);
      return result.data;
    },
    
    updatePermissions: async (channelId: string, permissions: any) => {
      const result = await api.put(`/chat/conversations/channel/${channelId}/permissions`, permissions);
      clearCache(`conversations/${channelId}`);
      return result.data;
    }
  },

  // Group operations with cache invalidation
  groupOperations: {
    addMember: async (groupId: string, userId: string) => {
      const result = await api.post(`/chat/conversations/group/${groupId}/member`, { userId });
      clearCache(`conversations/${groupId}`);
      return result.data;
    },
    
    removeMember: async (groupId: string, userId: string) => {
      const result = await api.delete(`/chat/conversations/group/${groupId}/member/${userId}`);
      clearCache(`conversations/${groupId}`);
      return result.data;
    },
    
    makeAdmin: async (groupId: string, userId: string) => {
      const result = await api.post(`/chat/conversations/group/${groupId}/admin`, { userId });
      clearCache(`conversations/${groupId}`);
      return result.data;
    },
    
    updateSettings: async (groupId: string, settings: any) => {
      const result = await api.put(`/chat/conversations/group/${groupId}/settings`, settings);
      clearCache(`conversations/${groupId}`);
      return result.data;
    }
  }
};

export const messageApi = {
  // Get messages for a conversation with caching
  getMessages: (conversationId: string) => 
    fetchData(`/chat/messages/${conversationId}`, {
      cacheTTL: MESSAGE_CACHE_TTL
    }),

  // Send regular message through socket
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
      if (!socket?.connected) {
        toast.error(i18next.t('error.socket.not_connected'));
        reject(new Error('Socket connection not available'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Message send timeout'));
        toast.error(i18next.t('error.message.send_timeout'));
      }, 5000);

      socket.emit('sendMessage', data, (response: SocketResponse) => {
        clearTimeout(timeout);
        if (response.error) {
          toast.error(response.error);
          reject(new Error(response.error));
        } else {
          // Clear message cache for this conversation
          clearCache(`messages/${data.conversationId}`);
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
    const socket = await ensureSocketConnection();
    if (!socket) {
      throw new Error('Socket connection not available');
    }
    
    const encryptedContent = encryption.encrypt(data.content, data.encryptionKey);
    
    return new Promise((resolve, reject) => {
      if (!socket?.connected) {
        toast.error(i18next.t('error.socket.not_connected'));
        reject(new Error('Socket connection not available'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Message send timeout'));
        toast.error(i18next.t('error.message.send_timeout'));
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
          // Clear message cache for this conversation
          clearCache(`messages/${data.conversationId}`);
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
        toast.error(i18next.t('error.socket.not_connected'));
        reject(new Error('Socket connection not available'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Edit timeout'));
        toast.error(i18next.t('error.message.edit_timeout'));
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
        toast.error(i18next.t('error.socket.not_connected'));
        reject(new Error('Socket connection not available'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Delete timeout'));
        toast.error(i18next.t('error.message.delete_timeout'));
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
