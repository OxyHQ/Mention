import { io, Socket } from 'socket.io-client';
import { API_URL_SOCKET_CHAT } from '@/config';
import { getData } from './storage';
import { toast } from 'sonner';

// Define socket types
export interface ChatSocket extends Socket {
    connected: boolean;
}

let socket: ChatSocket | null = null;
let retryCount = 0;
const MAX_RETRIES = 3;

export const initializeChatSocket = async (): Promise<ChatSocket | null> => {
    if (socket?.connected) return socket;
    
    if (socket) {
        socket.disconnect();
        socket = null;
    }

    try {
        const token = await getData('accessToken');
        if (!token) {
            console.error('No access token available');
            toast.error('Please log in to use chat features');
            return null;
        }

        const newSocket = io(`${API_URL_SOCKET_CHAT}/chat`, {
            auth: { token },
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: 5,
            timeout: 10000,
            autoConnect: false
        }) as ChatSocket;

        // Set up event handlers
        newSocket.on('connect', () => {
            console.log('Chat socket connected successfully');
            retryCount = 0;
            toast.success('Connected to chat server');
        });

        newSocket.on('connect_error', (error) => {
            console.error('Chat socket connection error:', error);
            if (retryCount < MAX_RETRIES) {
                retryCount++;
                console.log(`Retrying chat socket connection (${retryCount}/${MAX_RETRIES})...`);
                newSocket.connect();
            } else {
                console.error('Max chat socket connection retries reached');
                toast.error('Could not connect to chat server');
                disconnectChatSocket();
            }
        });

        newSocket.on('disconnect', (reason) => {
            console.log('Chat socket disconnected:', reason);
            if (reason === 'io server disconnect') {
                newSocket.connect();
            }
            toast.error('Disconnected from chat server');
        });

        newSocket.on('error', (error: Error) => {
            console.error('Chat socket error:', error);
            toast.error('Chat connection error: ' + (error.message || 'Unknown error'));
        });

        // Explicitly connect and wait for result
        newSocket.connect();

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                newSocket.disconnect();
                reject(new Error('Connection timeout'));
            }, 10000);

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

    } catch (error) {
        console.error('Error initializing chat socket:', error);
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
    if (socket) {
        socket.disconnect();
        socket = null;
        retryCount = 0;
    }
};