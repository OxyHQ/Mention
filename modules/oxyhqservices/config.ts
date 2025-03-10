/**
 * OxyHQ Services Configuration
 * 
 * This file contains all the configuration constants used throughout the OxyHQ services module.
 * Environment variables can be overridden for different environments.
 */

// Environment detection
const ENV = {
  IS_DEV: process.env.NODE_ENV === 'development',
  IS_PROD: process.env.NODE_ENV === 'production',
  IS_TEST: process.env.NODE_ENV === 'test',
};

// API Configuration
export const OXY_API_CONFIG = {
  BASE_URL: process.env.API_URL_OXY || "https://api.oxy.so",
  CLOUD_URL: process.env.OXY_CLOUD_URL || "https://api.oxy.so/files",
  TIMEOUT: 30000, // 30 seconds
  RETRY_ATTEMPTS: 3,
  VERSION: "v1",
  HEADERS: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Client-Version': '1.0.0',
  },
};

// Auth Configuration
export const OXY_AUTH_CONFIG = {
  TOKEN_REFRESH_INTERVAL: 15 * 60 * 1000, // 15 minutes
  SESSION_TIMEOUT: 7 * 24 * 60 * 60 * 1000, // 7 days
  MIN_PASSWORD_LENGTH: 8,
  REQUIRE_SPECIAL_CHAR: true,
  REQUIRE_NUMBER: true,
  REQUIRE_UPPERCASE: true,
  BIOMETRIC_ENABLED: true,
};

// Cache Configuration
export const OXY_CACHE_CONFIG = {
  DEFAULT_TTL: 5 * 60 * 1000, // 5 minutes
  FORCE_REFRESH: false,
  PROFILE_TTL: 10 * 60 * 1000, // 10 minutes
  SESSION_TTL: 30 * 60 * 1000, // 30 minutes
  RECOMMENDATIONS_TTL: 15 * 60 * 1000, // 15 minutes
  FILES_TTL: 2 * 60 * 1000, // 2 minutes
  STORAGE_PREFIX: 'oxy_cache_',
  MAX_CACHE_SIZE: 100, // Maximum number of items to cache
};

// File Upload Configuration
export const OXY_FILE_CONFIG = {
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
  ALLOWED_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'application/pdf'],
  UPLOAD_CHUNK_SIZE: 1024 * 1024, // 1MB chunks for large file uploads
  MAX_CONCURRENT_UPLOADS: 3,
  RETRY_FAILED_UPLOADS: true,
  MAX_RETRY_ATTEMPTS: 3,
};

// UI Configuration
export const OXY_UI_CONFIG = {
  TOAST_DURATION: 5000, // 5 seconds
  ANIMATION_DURATION: 300, // 300ms
  THEME: {
    PRIMARY_COLOR: '#3498db',
    SECONDARY_COLOR: '#2ecc71',
    ERROR_COLOR: '#e74c3c',
    WARNING_COLOR: '#f39c12',
    SUCCESS_COLOR: '#2ecc71',
    INFO_COLOR: '#3498db',
  },
};

// Feature Flags
export const OXY_FEATURES = {
  ENABLE_OFFLINE_MODE: true,
  ENABLE_ANALYTICS: true,
  ENABLE_PUSH_NOTIFICATIONS: true,
  ENABLE_BIOMETRIC_AUTH: true,
  ENABLE_SOCIAL_LOGIN: true,
  ENABLE_FILE_ENCRYPTION: true,
  ENABLE_DARK_MODE: true,
  ENABLE_BETA_FEATURES: ENV.IS_DEV,
};

// Logging Configuration
export const OXY_LOGGING_CONFIG = {
  LEVEL: ENV.IS_PROD ? 'error' : 'debug',
  ENABLE_REMOTE_LOGGING: ENV.IS_PROD,
  INCLUDE_USER_CONTEXT: true,
  REDACT_SENSITIVE_DATA: true,
  LOG_NETWORK_REQUESTS: !ENV.IS_PROD,
  LOG_PERFORMANCE_METRICS: true,
};

// Socket Configuration
export const OXY_SOCKET_CONFIG = {
  URL: process.env.SOCKET_URL || 'wss://api.oxy.so/socket',
  RECONNECT_ATTEMPTS: 5,
  RECONNECT_INTERVAL: 2000, // 2 seconds
  PING_INTERVAL: 30000, // 30 seconds
  PONG_TIMEOUT: 5000, // 5 seconds
  CONNECT_TIMEOUT: 10000, // 10 seconds
};

// For backwards compatibility, maintain old exports
export const API_URL_OXY = OXY_API_CONFIG.BASE_URL;
export const OXY_CLOUD_URL = OXY_API_CONFIG.CLOUD_URL;

// Export a unified config object
export const OXY_CONFIG = {
  ENV,
  API: OXY_API_CONFIG,
  AUTH: OXY_AUTH_CONFIG,
  CACHE: OXY_CACHE_CONFIG,
  FILE: OXY_FILE_CONFIG,
  UI: OXY_UI_CONFIG,
  FEATURES: OXY_FEATURES,
  LOGGING: OXY_LOGGING_CONFIG,
  SOCKET: OXY_SOCKET_CONFIG,
};