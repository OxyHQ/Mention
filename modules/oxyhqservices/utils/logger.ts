/**
 * Logger Utility
 * 
 * A centralized logging system for the OxyHQ services module.
 * Provides consistent logging with different log levels, context, and optional remote logging.
 */

import { OXY_LOGGING_CONFIG, OXY_CONFIG } from '../config';
import { getData } from './storage';
import { STORAGE_KEYS } from '../constants';

// Log levels
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal'
}

// Log level priorities (higher number = higher priority)
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.WARN]: 2,
  [LogLevel.ERROR]: 3,
  [LogLevel.FATAL]: 4
};

// Log entry structure
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: string;
  data?: any;
  userId?: string;
  sessionId?: string;
}

// Remote logging queue
const logQueue: LogEntry[] = [];
let isProcessingQueue = false;
const MAX_QUEUE_SIZE = 100;
const QUEUE_PROCESSING_INTERVAL = 10000; // 10 seconds

class Logger {
  private currentLogLevel: LogLevel;
  private enableRemoteLogging: boolean;
  private includeUserContext: boolean;
  private redactSensitiveData: boolean;
  
  constructor() {
    this.currentLogLevel = OXY_LOGGING_CONFIG.LEVEL as LogLevel || LogLevel.ERROR;
    this.enableRemoteLogging = OXY_LOGGING_CONFIG.ENABLE_REMOTE_LOGGING;
    this.includeUserContext = OXY_LOGGING_CONFIG.INCLUDE_USER_CONTEXT;
    this.redactSensitiveData = OXY_LOGGING_CONFIG.REDACT_SENSITIVE_DATA;
    
    // Start queue processing if remote logging is enabled
    if (this.enableRemoteLogging) {
      this.startQueueProcessing();
    }
  }
  
  /**
   * Log a debug message
   */
  debug(message: string, context?: string, data?: any): void {
    this.log(LogLevel.DEBUG, message, context, data);
  }
  
  /**
   * Log an info message
   */
  info(message: string, context?: string, data?: any): void {
    this.log(LogLevel.INFO, message, context, data);
  }
  
  /**
   * Log a warning message
   */
  warn(message: string, context?: string, data?: any): void {
    this.log(LogLevel.WARN, message, context, data);
  }
  
  /**
   * Log an error message
   */
  error(message: string, context?: string, data?: any): void {
    this.log(LogLevel.ERROR, message, context, data);
  }
  
  /**
   * Log a fatal error message
   */
  fatal(message: string, context?: string, data?: any): void {
    this.log(LogLevel.FATAL, message, context, data);
  }
  
  /**
   * Log a message with the specified level
   */
  private async log(level: LogLevel, message: string, context?: string, data?: any): Promise<void> {
    // Check if this log level should be processed
    if (!this.shouldLog(level)) {
      return;
    }
    
    // Create log entry
    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
      data: this.redactSensitiveData ? this.redactSensitiveFields(data) : data
    };
    
    // Add user context if enabled
    if (this.includeUserContext) {
      await this.addUserContext(logEntry);
    }
    
    // Console output
    this.consoleOutput(logEntry);
    
    // Queue for remote logging if enabled
    if (this.enableRemoteLogging && level !== LogLevel.DEBUG) {
      this.queueForRemoteLogging(logEntry);
    }
  }
  
  /**
   * Check if the given log level should be processed
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.currentLogLevel];
  }
  
  /**
   * Output log entry to console
   */
  private consoleOutput(entry: LogEntry): void {
    const { level, message, context, data } = entry;
    const timestamp = new Date(entry.timestamp).toLocaleTimeString();
    const contextStr = context ? `[${context}]` : '';
    const logMessage = `${timestamp} ${level.toUpperCase()} ${contextStr} ${message}`;
    
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(logMessage, data || '');
        break;
      case LogLevel.INFO:
        console.info(logMessage, data || '');
        break;
      case LogLevel.WARN:
        console.warn(logMessage, data || '');
        break;
      case LogLevel.ERROR:
      case LogLevel.FATAL:
        console.error(logMessage, data || '');
        break;
    }
  }
  
  /**
   * Add user context to log entry
   */
  private async addUserContext(entry: LogEntry): Promise<void> {
    try {
      const userId = await getData<string>(STORAGE_KEYS.USER_ID);
      if (userId) {
        entry.userId = userId;
      }
      
      // Add session ID if available
      const sessionId = await getData<string>('sessionId');
      if (sessionId) {
        entry.sessionId = sessionId;
      }
    } catch (error) {
      // Silently fail if we can't get user context
    }
  }
  
  /**
   * Queue log entry for remote logging
   */
  private queueForRemoteLogging(entry: LogEntry): void {
    // Add to queue, maintaining max size
    logQueue.push(entry);
    if (logQueue.length > MAX_QUEUE_SIZE) {
      logQueue.shift();
    }
  }
  
  /**
   * Start processing the remote logging queue
   */
  private startQueueProcessing(): void {
    setInterval(() => {
      this.processLogQueue();
    }, QUEUE_PROCESSING_INTERVAL);
  }
  
  /**
   * Process the remote logging queue
   */
  private async processLogQueue(): Promise<void> {
    if (isProcessingQueue || logQueue.length === 0) {
      return;
    }
    
    isProcessingQueue = true;
    
    try {
      // Take a snapshot of the current queue
      const logsToSend = [...logQueue];
      logQueue.length = 0;
      
      // Send logs to remote server
      await this.sendLogsToRemoteServer(logsToSend);
    } catch (error) {
      // If sending fails, add logs back to the queue
      console.error('Failed to send logs to remote server:', error);
      
      // Only add back the most recent logs to avoid queue growing too large
      const logsToRequeue = logQueue.length + MAX_QUEUE_SIZE > 2 * MAX_QUEUE_SIZE
        ? logQueue.slice(-MAX_QUEUE_SIZE)
        : logQueue;
      
      logQueue.push(...logsToRequeue);
    } finally {
      isProcessingQueue = false;
    }
  }
  
  /**
   * Send logs to remote server
   */
  private async sendLogsToRemoteServer(logs: LogEntry[]): Promise<void> {
    // Implementation would depend on your remote logging service
    // This is a placeholder for the actual implementation
    if (OXY_CONFIG.ENV.IS_DEV) {
      console.log('Would send logs to remote server:', logs);
      return;
    }
    
    // In production, you would send logs to your logging service
    // Example:
    // await fetch('https://logging.oxy.so/api/logs', {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ logs })
    // });
  }
  
  /**
   * Redact sensitive fields from log data
   */
  private redactSensitiveFields(data: any): any {
    if (!data || typeof data !== 'object') {
      return data;
    }
    
    const sensitiveFields = [
      'password', 'token', 'accessToken', 'refreshToken', 'secret',
      'apiKey', 'authorization', 'credential', 'pin', 'ssn', 'creditCard'
    ];
    
    const redacted = { ...data };
    
    for (const key in redacted) {
      if (Object.prototype.hasOwnProperty.call(redacted, key)) {
        // Check if this is a sensitive field
        if (sensitiveFields.some(field => key.toLowerCase().includes(field.toLowerCase()))) {
          redacted[key] = '[REDACTED]';
        } else if (typeof redacted[key] === 'object' && redacted[key] !== null) {
          // Recursively redact nested objects
          redacted[key] = this.redactSensitiveFields(redacted[key]);
        }
      }
    }
    
    return redacted;
  }
  
  /**
   * Set the current log level
   */
  setLogLevel(level: LogLevel): void {
    this.currentLogLevel = level;
  }
  
  /**
   * Enable or disable remote logging
   */
  setRemoteLogging(enabled: boolean): void {
    this.enableRemoteLogging = enabled;
    
    if (enabled && !isProcessingQueue) {
      this.startQueueProcessing();
    }
  }
  
  /**
   * Log performance metrics
   */
  logPerformance(operation: string, startTime: number, context?: string): void {
    if (!OXY_LOGGING_CONFIG.LOG_PERFORMANCE_METRICS) {
      return;
    }
    
    const duration = Date.now() - startTime;
    this.info(`Performance: ${operation} took ${duration}ms`, context || 'Performance', { duration });
  }
  
  /**
   * Create a scoped logger with a fixed context
   */
  createScopedLogger(context: string): {
    debug: (message: string, data?: any) => void;
    info: (message: string, data?: any) => void;
    warn: (message: string, data?: any) => void;
    error: (message: string, data?: any) => void;
    fatal: (message: string, data?: any) => void;
  } {
    return {
      debug: (message: string, data?: any) => this.debug(message, context, data),
      info: (message: string, data?: any) => this.info(message, context, data),
      warn: (message: string, data?: any) => this.warn(message, context, data),
      error: (message: string, data?: any) => this.error(message, context, data),
      fatal: (message: string, data?: any) => this.fatal(message, context, data)
    };
  }
}

// Export singleton instance
export const logger = new Logger(); 