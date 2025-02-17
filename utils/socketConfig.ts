import { ManagerOptions, SocketOptions } from 'socket.io-client';

export const SOCKET_CONFIG: Partial<ManagerOptions & SocketOptions> = {
    transports: ['websocket', 'polling'], // Try both WebSocket and polling
    upgrade: true, // Allow transport upgrade
    rememberUpgrade: true,
    timeout: 20000,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5,
    autoConnect: false,
    withCredentials: true,
    forceNew: true,
    path: '/socket.io',
    extraHeaders: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
    }
};

export interface SocketError extends Error {
    data?: any;
    type?: string;
}

export const isAuthError = (error: any): boolean => {
    if (!error) return false;
    const message = error.message || error.toString();
    return (
        message.includes('auth') ||
        message.includes('token') ||
        message.includes('unauthorized') ||
        message.includes('unauthenticated') ||
        error.type === 'AuthError'
    );
};

export const getReconnectDelay = (retryCount: number): number => {
    const base = SOCKET_CONFIG.reconnectionDelay || 1000;
    const max = SOCKET_CONFIG.reconnectionDelayMax || 5000;
    const delay = Math.min(base * Math.pow(2, retryCount - 1), max);
    return delay;
};

export const debug = {
    log: (...args: any[]) => {
        if (process.env.NODE_ENV !== 'production') {
            console.log('[Socket]', ...args);
        }
    },
    error: (...args: any[]) => {
        console.error('[Socket]', ...args);
    }
};