import { io, Socket } from 'socket.io-client';
import { API_URL_SOCKET_CHAT } from '@/config';
import { getData } from './storage';

let socket: Socket | null = null;
let retryCount = 0;
const MAX_RETRIES = 3;

export const initializeChatSocket = async () => {
    if (socket && socket.connected) return socket;

    try {
        const token = await getData('accessToken');
        if (!token) {
            console.error('No access token available for chat socket connection');
            return null;
        }
        
        socket = io(`${API_URL_SOCKET_CHAT}/chat`, {
            auth: { token },
            transports: ['websocket', 'polling'], // Support both WebSocket and polling
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: 5,
            autoConnect: true,
            timeout: 10000 // 10 second timeout for connection attempts
        });

        socket.on('connect', () => {
            console.log('Chat socket connected');
            retryCount = 0;
        });

        socket.on('connect_error', async (error) => {
            console.error('Chat socket connection error:', error);
            if (retryCount < MAX_RETRIES) {
                retryCount++;
                const newToken = await getData('accessToken');
                if (socket && newToken) {
                    console.log(`Retrying chat socket connection (${retryCount}/${MAX_RETRIES})...`);
                    socket.auth = { token: newToken };
                    socket.connect();
                }
            } else {
                console.error('Max chat socket connection retries reached');
                disconnectChatSocket();
            }
        });

        socket.on('disconnect', (reason) => {
            console.log('Chat socket disconnected:', reason);
            if (reason === 'io server disconnect') {
                socket?.connect();
            }
        });

        socket.on('error', (error) => {
            console.error('Chat socket error:', error);
        });

        return socket;
    } catch (error) {
        console.error('Error initializing chat socket:', error);
        return null;
    }
};

export const joinConversation = (conversationId: string) => {
    if (!socket?.connected) return;
    socket.emit('joinConversation', conversationId);
};

export const leaveConversation = (conversationId: string) => {
    if (!socket?.connected) return;
    socket.emit('leaveConversation', conversationId);
};

export const getChatSocket = () => socket;

export const disconnectChatSocket = () => {
    if (socket) {
        socket.disconnect();
        socket = null;
        retryCount = 0;
    }
};