/**
 * Error Handler Utility
 * 
 * This utility provides centralized error handling and logging for the OxyHQ services module.
 * It standardizes error formats, provides consistent logging, and helps with error recovery.
 */

import { toast } from 'sonner';
import axios, { AxiosError } from 'axios';

// Error types
export enum ErrorType {
  NETWORK = 'network',
  AUTHENTICATION = 'authentication',
  AUTHORIZATION = 'authorization',
  VALIDATION = 'validation',
  SERVER = 'server',
  CLIENT = 'client',
  UNKNOWN = 'unknown'
}

// Standard error structure
export interface StandardError {
  message: string;
  type: ErrorType;
  statusCode?: number;
  details?: Record<string, any>;
  originalError?: any;
}

/**
 * Normalize an error into a standard format
 */
export const normalizeError = (error: any, context?: string): StandardError => {
  let message = 'An unknown error occurred';
  let type = ErrorType.UNKNOWN;
  let statusCode: number | undefined = undefined;
  let details: Record<string, any> | undefined = undefined;
  
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    statusCode = axiosError.response?.status;
    
    // Extract error details from response
    if (axiosError.response?.data) {
      const data = axiosError.response.data as any;
      message = data.message || axiosError.message || 'API request failed';
      details = data.details || data;
    } else {
      message = axiosError.message;
    }
    
    // Determine error type based on status code
    if (!axiosError.response) {
      type = ErrorType.NETWORK;
    } else if (statusCode === 401) {
      type = ErrorType.AUTHENTICATION;
    } else if (statusCode === 403) {
      type = ErrorType.AUTHORIZATION;
    } else if (statusCode === 422 || statusCode === 400) {
      type = ErrorType.VALIDATION;
    } else if (statusCode && statusCode >= 500) {
      type = ErrorType.SERVER;
    } else if (statusCode && statusCode >= 400) {
      type = ErrorType.CLIENT;
    }
  } else if (error instanceof Error) {
    message = error.message;
    
    // Try to determine error type from message
    if (message.toLowerCase().includes('network') || 
        message.toLowerCase().includes('connection')) {
      type = ErrorType.NETWORK;
    } else if (message.toLowerCase().includes('authentication') || 
               message.toLowerCase().includes('login') ||
               message.toLowerCase().includes('token')) {
      type = ErrorType.AUTHENTICATION;
    }
  } else if (typeof error === 'string') {
    message = error;
  }
  
  // Log the error with context
  const logPrefix = context ? `[${context}]` : '';
  console.error(`${logPrefix} Error:`, {
    message,
    type,
    statusCode,
    details,
    originalError: error
  });
  
  return {
    message,
    type,
    statusCode,
    details,
    originalError: error
  };
};

/**
 * Handle an error with optional toast notification
 */
export const handleError = (
  error: any, 
  options: {
    context?: string;
    showToast?: boolean;
    fallbackMessage?: string;
    onAuthError?: () => void;
  } = {}
): StandardError => {
  const { 
    context, 
    showToast = true, 
    fallbackMessage,
    onAuthError
  } = options;
  
  const standardError = normalizeError(error, context);
  
  // Show toast notification if requested
  if (showToast) {
    toast.error(standardError.message || fallbackMessage || 'An error occurred');
  }
  
  // Call auth error handler if it's an authentication error
  if (standardError.type === ErrorType.AUTHENTICATION && onAuthError) {
    onAuthError();
  }
  
  return standardError;
};

/**
 * Create a safe error handler for async functions
 */
export const createSafeHandler = <T>(
  asyncFn: (...args: any[]) => Promise<T>,
  options: {
    context?: string;
    showToast?: boolean;
    fallbackMessage?: string;
    onAuthError?: () => void;
    onError?: (error: StandardError) => void;
  } = {}
) => {
  return async (...args: any[]): Promise<[T | null, StandardError | null]> => {
    try {
      const result = await asyncFn(...args);
      return [result, null];
    } catch (error) {
      const standardError = handleError(error, options);
      
      if (options.onError) {
        options.onError(standardError);
      }
      
      return [null, standardError];
    }
  };
};

/**
 * Check if an error is an authentication error
 */
export const isAuthError = (error: any): boolean => {
  if (axios.isAxiosError(error)) {
    return error.response?.status === 401;
  }
  
  if (error && typeof error === 'object' && 'type' in error) {
    return (error as StandardError).type === ErrorType.AUTHENTICATION;
  }
  
  return false;
};

export default {
  normalizeError,
  handleError,
  createSafeHandler,
  isAuthError,
  ErrorType
}; 