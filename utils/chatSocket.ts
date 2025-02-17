import { io, Socket } from 'socket.io-client';
import { API_URL_SOCKET_CHAT } from '@/config';
import { getData } from './storage';
import { toast } from 'sonner';
import { SOCKET_CONFIG, getReconnectDelay, debug } from './socketConfig';

// Enhanced socket types and token management
export interface ChatSocket extends Socket {
    connected: boolean;
}

let socket: ChatSocket | null = null;
let retryCount = 0;
let tokenRefreshTimeout: NodeJS.Timeout | null = null;

const refreshSocketToken = async (socket: ChatSocket) => {
    try {
        const newToken = await getData('accessToken');
        if (!newToken) throw new Error('No access token available');
        
        if (socket) {
            socket.auth = { token: newToken };
            socket.disconnect().connect(); // Force reconnection with new token
        }
    } catch (error) {
        debug.error('Token refresh failed:', error);
        disconnectChatSocket();
    }
};

const setupTokenRefresh = (socket: ChatSocket) => {
    if (tokenRefreshTimeout) {
        clearTimeout(tokenRefreshTimeout);
    }
    
    tokenRefreshTimeout = setTimeout(() => {
        refreshSocketToken(socket);
    }, 45 * 60 * 1000);
};

export const initializeChatSocket = async (): Promise<ChatSocket | null> => {
    if (socket?.connected) return socket;
    
    if (socket) {
        socket.disconnect();
        socket = null;
    }

    try {
        const token = await getData('accessToken');
        if (!token) {
            debug.error('No access token available');
            toast.error('Please log in to use chat features');
            return null;
        }

        const newSocket = io(`${API_URL_SOCKET_CHAT}/chat`, {
            ...SOCKET_CONFIG,
            auth: { token }
        }) as ChatSocket;

        // Set up event handlers
        newSocket.on('connect', () => {
            debug.log('Chat socket connected successfully');
            retryCount = 0;
            toast.success('Connected to chat server');
            setupTokenRefresh(newSocket);
        });

        newSocket.on('connect_error', async (error) => {
            debug.error('Chat socket connection error:', error);
            if (error.message?.includes('authentication')) {
                // Try to refresh token on auth errors
                await refreshSocketToken(newSocket);
                return;
            }

            if (retryCount < (SOCKET_CONFIG.reconnectionAttempts || 5)) {
                retryCount++;
                const delay = getReconnectDelay(retryCount);
                debug.log(`Retrying chat socket connection (${retryCount}/${SOCKET_CONFIG.reconnectionAttempts}) in ${delay}ms...`);
                setTimeout(() => {
                    if (newSocket) {
                        newSocket.connect();
                    }
                }, delay);
            } else {
                debug.error('Max chat socket connection retries reached');
                toast.error('Could not connect to chat server. Please refresh the page.');
                disconnectChatSocket();
            }
        });

        newSocket.io.on("error", (error) => {
            debug.error('Transport error:', error);
        });

        newSocket.io.on("reconnect_attempt", (attempt) => {
            debug.log('Reconnection attempt:', attempt);
        });

        newSocket.io.on("reconnect_error", (error) => {
            debug.error('Reconnection error:', error);
        });

        newSocket.io.on("reconnect_failed", () => {
            debug.error('Reconnection failed');
            toast.error('Chat connection lost. Please refresh the page.');
        });

        newSocket.on('disconnect', (reason) => {
            debug.log('Chat socket disconnected:', reason);
            if (reason === 'io server disconnect' || reason === 'transport close') {
                debug.log('Attempting to reconnect...');
                newSocket.connect();
            }
            toast.error('Disconnected from chat server');
        });

        newSocket.on('error', (error: Error) => {
            debug.error('Chat socket error:', error);
            toast.error('Chat connection error: ' + (error.message || 'Unknown error'));
        });

        // Explicitly connect and wait for result with timeout
        newSocket.connect();

        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    newSocket.disconnect();
                    reject(new Error('Connection timeout'));
                }, SOCKET_CONFIG.timeout || 20000);

                newSocket.once('connect', () => {
                    clearTimeout(timeout);
                    socket = newSocket;
                    resolve(newSocket);
                });

                newSocket.once('connect_error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            });

            return newSocket;
        } catch (error) {
            debug.error('Connection establishment failed:', error);
            newSocket.disconnect();
            throw error;
        }

    } catch (error) {
        debug.error('Error initializing chat socket:', error);
        toast.error('Failed to connect to chat server');
        return null;
    }
};

export const joinConversation = async (conversationId: string): Promise<boolean> => {
    const chatSocket = await initializeChatSocket();
    if (!chatSocket?.connected) {
        console.error('Not connected to chat server');
        toast.error('Not connected to chat server');
        return false;
    }
    
    return new Promise<boolean>((resolve) => {
        chatSocket.emit('joinConversation', conversationId, (response: any) => {
            if (response?.error) {
                toast.error(response.error);
                resolve(false);
            } else {
                resolve(true);
            }
        });
    });
};

export const getChatSocket = (): ChatSocket | null => socket;

export const disconnectChatSocket = (): void => {
    if (tokenRefreshTimeout) {
        clearTimeout(tokenRefreshTimeout);
        tokenRefreshTimeout = null;
    }
    
    if (socket) {
        socket.disconnect();
        socket = null;
        retryCount = 0;
    }
};