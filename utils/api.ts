import axios from "axios";
import { toast } from "sonner";
import { getData, storeData } from './storage';
import { router } from 'expo-router';
import { getSocket, disconnectSocket } from './socket';

const API_URL = process.env.API_URL || "http://localhost:3000/api";

// Cache configuration
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds
const cache = new Map();

// Batch request handling
interface BatchRequest {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  data?: any;
}

let batchTimeout: NodeJS.Timeout | null = null;
const batchQueue: BatchRequest[] = [];
const BATCH_DELAY = 50; // ms to wait before processing batch

// Create axios instance with default config
const api = axios.create({
  baseURL: API_URL,
  withCredentials: true, // Important for sending cookies/session
  headers: {
    'Content-Type': 'application/json'
  },
  transformRequest: [(data, headers) => {
    // Don't transform FormData
    if (data instanceof FormData) {
      return data;
    }
    // For other data types, use default transformation
    return JSON.stringify(data);
  }]
});

// Cache management
const getCacheKey = (endpoint: string, config?: any) => {
  return `${endpoint}${config ? JSON.stringify(config) : ''}`;
};

const setCache = (key: string, data: any) => {
  cache.set(key, {
    data,
    timestamp: Date.now()
  });
};

const getCache = (key: string) => {
  const cached = cache.get(key);
  if (!cached) return null;
  
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  
  return cached.data;
};

const clearCache = (pattern?: string) => {
  if (!pattern) {
    cache.clear();
    return;
  }
  
  const regex = new RegExp(pattern);
  for (const key of cache.keys()) {
    if (regex.test(key)) {
      cache.delete(key);
    }
  }
};

// Add request interceptor for authentication
api.interceptors.request.use(
  async (config) => {
    const accessToken = await getData('accessToken');
    if (accessToken) {
      config.headers.Authorization = `Bearer ${accessToken}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

interface QueueItem {
  resolve: (value?: any) => void;
  reject: (error?: any) => void;
}

let isRefreshing = false;
let failedQueue: QueueItem[] = [];

const processQueue = (error: Error | null, token: string | null = null) => {
  failedQueue.forEach(prom => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

// Add response interceptor for handling errors
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // If error is not 401 or request already tried after refresh
    if (error.response?.status !== 401 || originalRequest._retry) {
      return Promise.reject(error);
    }

    if (isRefreshing) {
      // Queue this request while refreshing
      return new Promise((resolve, reject) => {
        failedQueue.push({ resolve, reject });
      })
        .then(token => {
          originalRequest.headers['Authorization'] = `Bearer ${token}`;
          return api(originalRequest);
        })
        .catch(err => Promise.reject(err));
    }

    originalRequest._retry = true;
    isRefreshing = true;

    try {
      const refreshToken = await getData('refreshToken');
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }
      
      // Use a direct axios call to avoid interceptors
      const response = await axios.post(`${API_URL}/auth/refresh`, { refreshToken });

      if (response.data.accessToken && response.data.refreshToken) {
        await Promise.all([
          storeData('accessToken', response.data.accessToken),
          storeData('refreshToken', response.data.refreshToken)
        ]);
        
        // Update headers for retrying
        originalRequest.headers['Authorization'] = `Bearer ${response.data.accessToken}`;
        // Process other queued requests
        processQueue(null, response.data.accessToken);
        return api(originalRequest);
      }
      throw new Error('Invalid token refresh response');
    } catch (refreshError) {
      const error = refreshError instanceof Error ? refreshError : new Error('Token refresh failed');
      processQueue(error, null);
      // Clear stored tokens on refresh failure
      await Promise.all([
        storeData('accessToken', null),
        storeData('refreshToken', null),
        storeData('session', null)
      ]);
      toast.error("Session expired. Please log in again.");
      router.push('/login');
      return Promise.reject(error);
    } finally {
      isRefreshing = false;
    }
  }
);

// Batch processing function
const processBatchQueue = async () => {
  if (batchQueue.length === 0) return;
  
  const requests = [...batchQueue];
  batchQueue.length = 0;
  
  try {
    const response = await api.post('/batch', { requests });
    return response.data;
  } catch (error) {
    console.error('Batch request failed:', error);
    throw error;
  }
};

// Enhanced fetch with caching
export const fetchData = async (endpoint: string, config?: any) => {
  const cacheKey = getCacheKey(endpoint, config);
  const cachedData = getCache(cacheKey);
  
  if (cachedData) {
    return cachedData;
  }
  
  try {
    const response = await api.get(endpoint, config);
    setCache(cacheKey, response.data);
    return response.data;
  } catch (error: any) {
    const errorMessage = error.response?.data?.message || error.message;
    toast.error(`Error fetching data: ${errorMessage}`);
    throw error;
  }
};

// Batch request helper
const addToBatch = (request: BatchRequest): Promise<any> => {
  return new Promise((resolve, reject) => {
    batchQueue.push({
      ...request,
      resolve,
      reject,
    });
    
    if (batchTimeout) {
      clearTimeout(batchTimeout);
    }
    
    batchTimeout = setTimeout(() => {
      processBatchQueue()
        .then(results => {
          results.forEach((result: any, index: number) => {
            const request = batchQueue[index] as any;
            if (result.error) {
              request.reject(result.error);
            } else {
              request.resolve(result.data);
            }
          });
        })
        .catch(error => {
          batchQueue.forEach(request => (request as any).reject(error));
        });
    }, BATCH_DELAY);
  });
};

// Enhanced data mutation methods
export const deleteData = async (endpoint: string, data?: any) => {
  try {
    const response = await api.delete(endpoint, data);
    clearCache(endpoint);
    return response.data;
  } catch (error: any) {
    const errorMessage = error.response?.data?.message || error.message;
    toast.error(`Error deleting data: ${errorMessage}`);
    throw error;
  }
};

export const postData = async (endpoint: string, data: any) => {
  try {
    const response = await api.post(endpoint, data);
    clearCache(endpoint);
    return response.data;
  } catch (error: any) {
    const errorMessage = error.response?.data?.message || error.message;
    toast.error(`Error posting data: ${errorMessage}`);
    throw error;
  }
};

export const putData = async (endpoint: string, data: any) => {
  try {
    const response = await api.put(endpoint, data);
    clearCache(endpoint);
    return response.data;
  } catch (error: any) {
    const errorMessage = error.response?.data?.message || error.message;
    toast.error(`Error updating data: ${errorMessage}`);
    throw error;
  }
};

export const patchData = async (endpoint: string, data: any) => {
  try {
    const response = await api.patch(endpoint, data);
    clearCache(endpoint);
    return response.data;
  } catch (error: any) {
    const errorMessage = error.response?.data?.message || error.message;
    toast.error(`Error patching data: ${errorMessage}`);
    throw error;
  }
};

export const login = async (username: string, password: string) => {
  try {
    const response = await api.post(`/auth/signin`, { username, password });
    if (response.data.accessToken && response.data.refreshToken) {
      await storeData('accessToken', response.data.accessToken);
      await storeData('refreshToken', response.data.refreshToken);
      await storeData('user', response.data.user);
    }
    return response.data;
  } catch (error) {
    toast.error('Error logging in: ' + error);
    throw error;
  }
};

export const refreshAccessToken = async () => {
  try {
    const refreshToken = await getData('refreshToken');
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }
    
    const response = await axios.post(`${API_URL}/auth/refresh`, { refreshToken }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (response.data.accessToken && response.data.refreshToken) {
      await Promise.all([
        storeData('accessToken', response.data.accessToken),
        storeData('refreshToken', response.data.refreshToken)
      ]);
      
      // Reconnect socket with new token
      const socket = getSocket();
      socket.disconnect();
      socket.auth = { token: response.data.accessToken };
      socket.connect();
      
      return response.data.accessToken;
    }
    throw new Error('Invalid token refresh response');
  } catch (error: any) {
    // Clear tokens on refresh failure
    await Promise.all([
      storeData('accessToken', null),
      storeData('refreshToken', null),
      storeData('session', null)
    ]);
    disconnectSocket();
    
    if (error.response?.status === 401) {
      throw new Error('Session expired. Please log in again.');
    }
    throw error;
  }
};

export const logout = async () => {
  try {
    const refreshToken = await getData('refreshToken');
    if (refreshToken) {
      await api.post(`/auth/logout`, { refreshToken });
    }
    await storeData('accessToken', null);
    await storeData('refreshToken', null);
    disconnectSocket(); // Disconnect socket on logout
  } catch (error) {
    toast.error('Error logging out: ' + error);
    throw error;
  }
};

export const validateSession = async (): Promise<boolean> => {
  try {
    const accessToken = await getData('accessToken');
    if (!accessToken) {
      return false;
    }

    const response = await api.get('/auth/validate');
    return response.data.valid === true;
  } catch (error: any) {
    if (error.response?.status === 401) {
      throw new Error('Session expired');
    }
    return false;
  }
};

// Export the api instance for direct use
export const clearApiCache = clearCache;
export const invalidateCache = (pattern: string) => clearCache(pattern);

export default api;
