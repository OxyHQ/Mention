/**
 * OxyHQ Services Configuration
 * 
 * This file contains all the configuration constants used throughout the OxyHQ services module.
 * Environment variables can be overridden for different environments.
 */

// API Configuration
export const OXY_API_CONFIG = {
  BASE_URL: process.env.API_URL_OXY || "https://api.oxy.so",
  CLOUD_URL: process.env.OXY_CLOUD_URL || "https://api.oxy.so/files",
  TIMEOUT: 30000, // 30 seconds
  RETRY_ATTEMPTS: 3,
  VERSION: "v1"
};

// Auth Configuration
export const OXY_AUTH_CONFIG = {
  TOKEN_REFRESH_INTERVAL: 15 * 60 * 1000, // 15 minutes
  SESSION_TIMEOUT: 7 * 24 * 60 * 60 * 1000 // 7 days
};

// Cache Configuration
export const OXY_CACHE_CONFIG = {
  DEFAULT_TTL: 5 * 60 * 1000, // 5 minutes
  FORCE_REFRESH: false
};

// For backwards compatibility, maintain old exports
export const API_URL_OXY = OXY_API_CONFIG.BASE_URL;
export const OXY_CLOUD_URL = OXY_API_CONFIG.CLOUD_URL;