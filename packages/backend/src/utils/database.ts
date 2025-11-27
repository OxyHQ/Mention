import mongoose from "mongoose";
import { logger } from "./logger";

let connectPromise: Promise<typeof mongoose> | null = null;
let retryCount = 0;
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY = 1000; // 1 second

/**
 * Calculate exponential backoff delay
 */
function getRetryDelay(attempt: number): number {
  return INITIAL_RETRY_DELAY * Math.pow(2, attempt);
}

/**
 * Wait for a specified number of milliseconds
 */
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  if (connectPromise) {
    return connectPromise;
  }

  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error("MONGODB_URI environment variable is not defined");
  }

  // Log connection string info (without credentials) for debugging
  const uriInfo = mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'); // Mask credentials
  logger.debug(`Attempting to connect to MongoDB: ${uriInfo.substring(0, 100)}...`);

  const connectWithRetry = async (): Promise<typeof mongoose> => {
    try {
      await mongoose.connect(mongoUri, {
        autoIndex: process.env.NODE_ENV !== 'production', // Disable in production for performance
        autoCreate: true,
        serverSelectionTimeoutMS: 20000,
        socketTimeoutMS: 45000,
        // Connection pool configuration optimized for millions of users
        // Increased pool size to handle high concurrent load
        maxPoolSize: parseInt(process.env.MONGODB_MAX_POOL_SIZE || '100'), // Maximum number of connections in pool (increased from 50)
        minPoolSize: parseInt(process.env.MONGODB_MIN_POOL_SIZE || '10'), // Minimum number of connections to maintain (increased from 5)
        maxIdleTimeMS: 60000, // Close connections after 60 seconds of inactivity (increased from 30s for better connection reuse)
        // Read preference for read replicas (if configured)
        readPreference: process.env.MONGODB_READ_PREFERENCE as any || 'primary',
        // Write concern for data durability
        w: 'majority',
        wtimeoutMS: 5000, // Fixed: use wtimeoutMS instead of deprecated wtimeout
        // Retry configuration
        retryWrites: true,
        retryReads: true,
        // Heartbeat configuration
        heartbeatFrequencyMS: 10000, // Check server status every 10 seconds
      });

      retryCount = 0; // Reset retry count on successful connection
      logger.info("Connected to MongoDB successfully");
      return mongoose;
    } catch (error: any) {
      retryCount++;
      
      // Provide helpful error diagnostics
      const errorCode = error?.code || error?.syscall || '';
      const errorMessage = error?.message || error?.toString() || 'Unknown error';
      
      if (retryCount < MAX_RETRIES) {
        const delay = getRetryDelay(retryCount - 1);
        // Only log first few attempts to reduce spam
        if (retryCount <= 3) {
          logger.warn(`MongoDB connection failed (attempt ${retryCount}/${MAX_RETRIES}), retrying in ${delay}ms...`);
          
          // Provide specific guidance based on error type
          if (errorCode === 'querySrv' || errorMessage.includes('querySrv')) {
            logger.warn('  → DNS SRV lookup failed. Possible causes:');
            logger.warn('     - Network connectivity issue');
            logger.warn('     - Firewall blocking DNS queries');
            logger.warn('     - DNS server unreachable');
            logger.warn('     - MongoDB hostname incorrect or unreachable');
          } else if (errorCode === 'ECONNREFUSED') {
            logger.warn('  → Connection refused. Possible causes:');
            logger.warn('     - MongoDB server is down');
            logger.warn('     - IP address not whitelisted in MongoDB cluster');
            logger.warn('     - Firewall blocking port 27017');
          }
        }
        await wait(delay);
        return connectWithRetry();
      } else {
        retryCount = 0;
        connectPromise = null;
        logger.error("Failed to connect to MongoDB after maximum retries - app will continue without database");
        
        // Final diagnostic message
        if (errorCode === 'querySrv' || errorMessage.includes('querySrv')) {
          logger.error('  → DNS SRV resolution failed. Check:');
          logger.error('     1. Network connectivity and DNS settings');
          logger.error('     2. MongoDB connection string format (mongodb+srv://...)');
          logger.error('     3. DigitalOcean MongoDB cluster status and IP whitelist');
        }
        
        // Don't throw - allow app to start without MongoDB (graceful degradation)
        // Return mongoose instance anyway - operations will fail gracefully
        return mongoose;
      }
    }
  };

  connectPromise = connectWithRetry();
  
  try {
    return await connectPromise;
  } catch (error) {
    connectPromise = null;
    throw error;
  }
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

/**
 * Get database connection statistics
 */
export function getDatabaseStats() {
  const state = mongoose.connection.readyState;
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  
  return {
    state: states[state] || 'unknown',
    readyState: state,
    host: mongoose.connection.host,
    port: mongoose.connection.port,
    name: mongoose.connection.name,
    // Connection pool stats (if available)
    poolSize: (mongoose.connection.db as any)?.serverConfig?.poolSize,
  };
}


