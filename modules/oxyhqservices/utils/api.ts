import axios, { AxiosError } from "axios";
import { toast } from "sonner";
import { getData, storeData, getSecureData, storeSecureData } from './storage';
import { router } from 'expo-router';
import { getSocket, disconnectSocket } from './socket';
import { API_URL_OXY } from "../config";
import { STORAGE_KEYS } from '../constants';

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const MAX_RETRY_DELAY = 10000; // 10 seconds

// Cache configuration
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds
const cache = new Map();

// Batch request handling
interface BatchRequest {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  data?: any;
  resolve?: (value?: any) => void;
  reject?: (error?: any) => void;
}

let batchTimeout: NodeJS.Timeout | null = null;
const batchQueue: BatchRequest[] = [];
const BATCH_DELAY = 50; // ms to wait before processing batch

// Create axios instance with default config and timeout
const api = axios.create({
  baseURL: API_URL_OXY,
  withCredentials: true, // Important for sending cookies/session
  timeout: 10000, // 10 second timeout
  headers: {
    'Content-Type': 'application/json'
  }
});

// Retry logic with exponential backoff
const retryRequest = async (error: AxiosError, retryCount: number = 0): Promise<any> => {
  const shouldRetry = retryCount < MAX_RETRIES &&
    (error.code === 'ECONNABORTED' || 
     error.code === 'ETIMEDOUT' || 
     error.response?.status === 429 ||
     (error.response?.status ?? 0) >= 500);

  if (!shouldRetry) {
    throw error;
  }

  const delay = Math.min(
    INITIAL_RETRY_DELAY * Math.pow(2, retryCount),
    MAX_RETRY_DELAY
  );

  await new Promise(resolve => setTimeout(resolve, delay));
  
  const config = error.config;
  if (!config) throw error;
  
  return api.request(config).catch(nextError => 
    retryRequest(nextError, retryCount + 1)
  );
};

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

// Event system for auth state changes
type AuthEventListener = () => void;
const authEventListeners: AuthEventListener[] = [];

export const addAuthEventListener = (listener: AuthEventListener) => {
  authEventListeners.push(listener);
};

export const removeAuthEventListener = (listener: AuthEventListener) => {
  const index = authEventListeners.indexOf(listener);
  if (index > -1) {
    authEventListeners.splice(index, 1);
  }
};

const notifyAuthEvent = () => {
  authEventListeners.forEach(listener => listener());
};

// Enhanced request interceptor without unsafe headers
api.interceptors.request.use(
  async (config) => {
    const accessToken = await getSecureData<string>(STORAGE_KEYS.ACCESS_TOKEN);
    if (accessToken) {
      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${accessToken}`;
    }

    // Don't transform FormData
    if (config.data instanceof FormData) {
      config.headers['Content-Type'] = 'multipart/form-data';
    }

    console.debug('[API] Request configuration:', {
      url: config.url,
      method: config.method,
      contentType: config.headers['Content-Type'],
      hasToken: !!accessToken
    });

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

// Enhanced response interceptor with retry logic
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    // Handle retry logic for connection errors
    if (error.code === 'ECONNABORTED' || 
        error.code === 'ETIMEDOUT' || 
        error.response?.status === 429 ||
        (error.response?.status ?? 0) >= 500) {
      return retryRequest(error);
    }

    // Handle token refresh as before
    const originalRequest = error.config;
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
      const response = await axios.post(`${API_URL_OXY}/auth/refresh`, { refreshToken });

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
      notifyAuthEvent();
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
export const fetchData = async (endpoint: string, options: { params?: Record<string, any> } & RequestInit = {}) => {
  try {
    const cacheKey = getCacheKey(endpoint, options);
    const cached = getCache(cacheKey);
    if (cached) return cached;

    const accessToken = await getSecureData<string>(STORAGE_KEYS.ACCESS_TOKEN);
    const headers = new Headers(options.headers);
    
    if (accessToken) {
      headers.set('Authorization', `Bearer ${accessToken}`);
    }

    // Handle query parameters
    const { params, ...fetchOptions } = options;
    const queryString = params ? '?' + new URLSearchParams(params).toString() : '';
    const url = `${API_URL_OXY}/${endpoint}${queryString}`;

    const response = await fetch(url, {
      ...fetchOptions,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    });

    if (!response.ok) {
      const data = await response.json();
      console.error('[API] Request failed:', { 
        endpoint, 
        status: response.status,
        error: data.error || data.message 
      });
      if (response.status === 401) {
        await forceLogout();
        throw new Error('AUTH_ERROR');
      }
      throw new Error(data.error || data.message || 'Request failed');
    }

    const data = await response.json();
    // Cache the response data
    setCache(cacheKey, data);
    return data;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('An unexpected error occurred');
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

// Centralized error handling
const handleApiError = (error: any, context: string): Error => {
  let errorMessage = 'An unknown error occurred';
  let statusCode = 0;
  let errorData: any = null;
  
  if (axios.isAxiosError(error)) {
    statusCode = error.response?.status || 0;
    errorData = error.response?.data;
    
    if (errorData && typeof errorData === 'object' && 'message' in errorData) {
      errorMessage = errorData.message as string;
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    // Log detailed error information
    console.error(`[API Error][${context}]`, {
      status: statusCode,
      message: errorMessage,
      data: errorData,
      url: error.config?.url,
      method: error.config?.method
    });
  } else if (error instanceof Error) {
    errorMessage = error.message;
    console.error(`[API Error][${context}]`, {
      message: errorMessage,
      stack: error.stack
    });
  } else {
    console.error(`[API Error][${context}]`, error);
  }
  
  // Create a standardized error object
  const enhancedError = new Error(errorMessage);
  (enhancedError as any).statusCode = statusCode;
  (enhancedError as any).data = errorData;
  (enhancedError as any).context = context;
  
  return enhancedError;
};

export const refreshAccessToken = async () => {
  try {
    const refreshToken = await getSecureData<string>(STORAGE_KEYS.REFRESH_TOKEN);
    if (!refreshToken) {
      console.error('[API] No refresh token available');
      throw new Error('No refresh token available');
    }

    console.debug('[API] Attempting token refresh');
    
    // Use a direct axios call to avoid interceptors
    const response = await axios.post(`${API_URL_OXY}/auth/refresh`, { refreshToken });
    
    if (response.data.accessToken) {
      console.debug('[API] Token refresh successful');
      
      // Store the new tokens
      await Promise.all([
        storeSecureData(STORAGE_KEYS.ACCESS_TOKEN, response.data.accessToken),
        response.data.refreshToken ? 
          storeSecureData(STORAGE_KEYS.REFRESH_TOKEN, response.data.refreshToken) : 
          Promise.resolve()
      ]);
      
      return response.data.accessToken;
    } else {
      throw new Error('Invalid token refresh response');
    }
  } catch (error) {
    throw handleApiError(error, 'refreshAccessToken');
  }
};

export const logout = async () => {
  try {
    // Try to call the logout endpoint
    try {
      await api.post('/auth/logout');
    } catch (error) {
      console.warn('[API] Server logout failed:', error);
      // Continue with local logout even if server call fails
    }
    
    // Clear all tokens and session data
    await Promise.all([
      storeSecureData(STORAGE_KEYS.ACCESS_TOKEN, null),
      storeSecureData(STORAGE_KEYS.REFRESH_TOKEN, null),
      storeData(STORAGE_KEYS.USER, null),
      storeData(STORAGE_KEYS.USER_ID, null),
      storeData(STORAGE_KEYS.SESSIONS, null)
    ]);
    
    // Disconnect socket
    disconnectSocket();
    
    // Notify auth event listeners
    notifyAuthEvent();
    
    return true;
  } catch (error) {
    console.error('[API] Logout error:', error);
    return false;
  }
};

export const validateSession = async (): Promise<boolean> => {
  try {
    const accessToken = await getSecureData<string>(STORAGE_KEYS.ACCESS_TOKEN);
    if (!accessToken) return false;
    
    // Check token expiration
    try {
      const parts = accessToken.split('.');
      if (parts.length !== 3) return false;
      
      const payload = JSON.parse(atob(parts[1]));
      const exp = payload.exp * 1000; // Convert to milliseconds
      const now = Date.now();
      
      // If token expires in less than 5 minutes, refresh it
      if (exp - now < 5 * 60 * 1000) {
        const refreshResult = await refreshAccessToken();
        return !!refreshResult;
      }
      
      return true;
    } catch (error) {
      console.error('Error parsing token:', error);
      return false;
    }
  } catch (error) {
    console.error('Session validation error:', error);
    return false;
  }
};

// Export the api instance for direct use
export const clearApiCache = clearCache;
export const invalidateCache = (pattern: string) => clearCache(pattern);


export const fetchUsersByUsername = async (username: string) => {
  try {
    const response = await api.get(`/search?query=${username}&type=users`);
    return response.data.users;
  } catch (error: any) {
    const errorMessage = error.response?.data?.message || error.message;
    toast.error(`Error fetching users: ${errorMessage}`);
    throw error;
  }
};

export const forceLogout = async () => {
  try {
    // Clear all tokens and session data without calling server
    await Promise.all([
      storeSecureData(STORAGE_KEYS.ACCESS_TOKEN, null),
      storeSecureData(STORAGE_KEYS.REFRESH_TOKEN, null),
      storeData(STORAGE_KEYS.USER, null),
      storeData(STORAGE_KEYS.USER_ID, null),
      storeData(STORAGE_KEYS.SESSIONS, null)
    ]);
    
    // Disconnect socket
    disconnectSocket();
    
    // Notify auth event listeners
    notifyAuthEvent();
    
    // Redirect to login
    if (router) {
      router.replace('/login');
    }
  } catch (error) {
    console.error('[API] Force logout error:', error);
  }
};

export default api;
