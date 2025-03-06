/**
 * OxyHQ Services Constants
 * 
 * This file contains constants used throughout the OxyHQ services module.
 * Centralizing these values helps maintain consistency across the application.
 */

// API Endpoints
export const ENDPOINTS = {
  AUTH: {
    LOGIN: '/auth/login',
    REGISTER: '/auth/register',
    REFRESH: '/auth/refresh',
    LOGOUT: '/auth/logout',
    VALIDATE: '/auth/validate',
  },
  USERS: {
    PROFILE: (id: string) => `/users/${id}`,
    SESSIONS: '/users/sessions',
    FOLLOWERS: (id: string) => `/users/${id}/followers`,
    FOLLOWING: (id: string) => `/users/${id}/following`,
  },
  FILES: {
    LIST: (userId: string) => `/files/list/${userId}`,
    UPLOAD: '/files/upload',
    DELETE: (fileId: string) => `/files/${fileId}`,
  },
  SUBSCRIPTION: {
    GET: (userId: string) => `/subscriptions/${userId}`,
    UPDATE: (userId: string) => `/subscriptions/${userId}`,
    CANCEL: (userId: string) => `/subscriptions/${userId}`,
  }
};

// Storage Keys
export const STORAGE_KEYS = {
  ACCESS_TOKEN: 'accessToken',
  REFRESH_TOKEN: 'refreshToken',
  USER: 'user',
  USER_ID: 'userId',
  SESSIONS: 'sessions',
  SETTINGS: 'userSettings'
};

// Default values
export const DEFAULTS = {
  SESSION_EXPIRE_TIME: 7 * 24 * 60 * 60 * 1000, // 7 days
  CACHE_TIMEOUT: 5 * 60 * 1000, // 5 minutes
  MAX_FILES: 5,
  MAX_UPLOAD_SIZE: 10 * 1024 * 1024, // 10MB
  ALLOWED_FILE_TYPES: ['image/', 'video/', 'application/pdf'],
};

// Error messages
export const ERROR_MESSAGES = {
  DEFAULT: 'An error occurred. Please try again.',
  NETWORK: 'Network error. Please check your connection.',
  UNAUTHORIZED: 'Session expired. Please sign in again.',
  VALIDATION: 'Please check the form for errors.',
  FILE_SIZE: 'File too large. Maximum size is 10MB.',
  FILE_TYPE: 'Invalid file type.',
  SESSION_EXPIRED: 'Your session has expired. Please sign in again.'
};