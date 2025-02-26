// Base URLs
export const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';
export const SOCKET_URL = process.env.EXPO_PUBLIC_SOCKET_URL || 'http://localhost:3000';

// Other config values
export const DEFAULT_AVATAR = 'https://mention.earth/default-avatar.png';
export const DEFAULT_COVER = 'https://mention.earth/default-cover.png';

export const API_URL_OXY = process.env.API_URL_OXY || "http://api.mention.earth";
export const API_URL_SOCKET = process.env.API_URL_SOCKET || "ws://api.mention.earth"; // Remove  suffix
export const OXY_CLOUD_URL = process.env.OXY_CLOUD_URL || "http://api.mention.earth/files/";
export const API_URL_SOCKET_CHAT = process.env.API_URL_SOCKET_CHAT || "http://api.mention.earth";
export const API_OXY_CHAT = process.env.API_OXY_CHAT || "http://api.mention.earth";