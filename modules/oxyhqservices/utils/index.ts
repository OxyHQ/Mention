/**
 * OxyHQ Services Utilities
 * 
 * Helper functions and utilities for the OxyHQ services module.
 */

// Export API utilities
export * from './api';

// Export storage utilities
export * from './storage';

// Export socket utilities
export * from './socket';
export * from './socketConfig';

// Export error handling utilities
export { 
  normalizeError,
  handleError,
  createSafeHandler,
  ErrorType
} from './errorHandler';

// Export default error handler
import errorHandler from './errorHandler';
export { errorHandler };