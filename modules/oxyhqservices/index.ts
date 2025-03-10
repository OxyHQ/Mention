/**
 * OxyHQ Services Module
 * 
 * This module provides authentication, profile management, file handling, and other
 * services for interacting with the OxyHQ API.
 * 
 * @module oxyhqservices
 */

// Configuration
export * from './config';

// Constants
export * from './constants';

// Core Services
export * from './services';

// Components
export * from './components';

// Hooks
export * from './hooks';

// Types
export * from './types';

// Redux Reducers
export * from './reducers';

// Shared styles
export * from './styles/shared';

// Utilities
export * from './utils';

// Version information
export const VERSION = {
  name: 'oxyhqservices',
  version: '1.0.0',
  description: 'OxyHQ Services Module',
  author: 'OxyHQ Team',
};

/**
 * Initialize the OxyHQ services module
 * @param options Configuration options
 */
export function initialize(options?: {
  apiUrl?: string;
  cloudUrl?: string;
  enableLogging?: boolean;
  logLevel?: string;
  enableOfflineMode?: boolean;
}): void {
  // Import configuration and services
  const { OXY_CONFIG } = require('./config');
  const { logger } = require('./utils/logger');
  
  // Override configuration with provided options
  if (options) {
    if (options.apiUrl) {
      OXY_CONFIG.API.BASE_URL = options.apiUrl;
    }
    
    if (options.cloudUrl) {
      OXY_CONFIG.API.CLOUD_URL = options.cloudUrl;
    }
    
    if (options.enableLogging !== undefined) {
      OXY_CONFIG.LOGGING.ENABLE_REMOTE_LOGGING = options.enableLogging;
    }
    
    if (options.logLevel) {
      OXY_CONFIG.LOGGING.LEVEL = options.logLevel;
      logger.setLogLevel(options.logLevel);
    }
    
    if (options.enableOfflineMode !== undefined) {
      OXY_CONFIG.FEATURES.ENABLE_OFFLINE_MODE = options.enableOfflineMode;
    }
  }
  
  // Log initialization
  logger.info('OxyHQ Services initialized', 'Initialization', {
    version: VERSION.version,
    config: {
      apiUrl: OXY_CONFIG.API.BASE_URL,
      cloudUrl: OXY_CONFIG.API.CLOUD_URL,
      environment: OXY_CONFIG.ENV.IS_PROD ? 'production' : 'development'
    }
  });
}