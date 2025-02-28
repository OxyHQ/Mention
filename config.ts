// Base URLs
export const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';
export const SOCKET_URL = process.env.EXPO_PUBLIC_SOCKET_URL || 'http://localhost:3000';

export const API_URL_OXY = process.env.API_URL_OXY || "http://localhost:3000";
export const API_URL_SOCKET = process.env.API_URL_SOCKET || "ws://localhost:3000"; // Remove  suffix
export const OXY_CLOUD_URL = process.env.OXY_CLOUD_URL || "http://localhost:3000/files/";
export const API_URL_SOCKET_CHAT = process.env.API_URL_SOCKET_CHAT || "http://localhost:3000";
export const API_OXY_CHAT = process.env.API_OXY_CHAT || "http://localhost:3000";