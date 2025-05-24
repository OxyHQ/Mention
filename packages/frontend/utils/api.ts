import axios, { AxiosRequestConfig } from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { toast } from 'sonner';
import { API_URL } from '@/config';

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const BATCH_DELAY = 50; // ms to wait before processing batch
const MAX_BATCH_SIZE = 10;

// Enhanced cache implementation with typed interface and TTL support
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

interface BatchRequest {
  config: AxiosRequestConfig;
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

const cache = new Map<string, CacheEntry<any>>();
let batchQueue: BatchRequest[] = [];
let batchTimeout: NodeJS.Timeout | null = null;

export const clearCache = (pattern?: string) => {
  if (pattern) {
    const regex = new RegExp(pattern);
    for (const key of cache.keys()) {
      if (regex.test(key)) {
        cache.delete(key);
      }
    }
  } else {
    cache.clear();
  }
};

export const getCacheKey = (endpoint: string, params?: any) => {
  return `${endpoint}${params ? `-${JSON.stringify(params)}` : ''}`;
};

export const setCacheEntry = <T>(key: string, data: T, ttl = CACHE_DURATION) => {
  cache.set(key, {
    data,
    timestamp: Date.now(),
    ttl
  });
};

export const getCacheEntry = <T>(key: string): T | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  
  if (Date.now() - entry.timestamp > entry.ttl) {
    cache.delete(key);
    return null;
  }
  
  return entry.data as T;
};

// Request batching implementation
const processBatch = async () => {
  const batch = batchQueue.splice(0, MAX_BATCH_SIZE);
  batchTimeout = null;

  if (batch.length === 0) return;

  try {
    // Group similar requests
    const requestGroups = batch.reduce((groups, request) => {
      const key = `${request.config.method}-${request.config.url}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(request);
      return groups;
    }, {} as Record<string, BatchRequest[]>);

    // Process each group
    await Promise.all(
      Object.values(requestGroups).map(async (requests) => {
        try {
          if (requests.length === 1) {
            // Single request
            const response = await api(requests[0].config);
            requests[0].resolve(response.data);
          } else {
            // Batch similar requests
            const params = requests.map(r => r.config.params || {});
            const response = await api({
              ...requests[0].config,
              params: { batch: params }
            });
            
            // Distribute responses
            requests.forEach((request, index) => {
              request.resolve(Array.isArray(response.data) ? response.data[index] : response.data);
            });
          }
        } catch (error) {
          requests.forEach(request => request.reject(error));
        }
      })
    );
  } catch (error) {
    batch.forEach(request => request.reject(error));
  }
};

export const batchRequest = <T>(config: AxiosRequestConfig): Promise<T> => {
  return new Promise((resolve, reject) => {
    batchQueue.push({ config, resolve, reject });
    
    if (batchTimeout) clearTimeout(batchTimeout);
    batchTimeout = setTimeout(processBatch, BATCH_DELAY);
  });
};

// Enhanced fetchData with caching and batching
export const fetchData = async <T>(
  endpoint: string,
  options: {
    params?: any;
    skipCache?: boolean;
    cacheTTL?: number;
    skipBatch?: boolean;
  } = {}
) => {
  const { params, skipCache = false, cacheTTL = CACHE_DURATION, skipBatch = false } = options;
  
  // Check cache first
  if (!skipCache) {
    const cacheKey = getCacheKey(endpoint, params);
    const cachedData = getCacheEntry<T>(cacheKey);
    if (cachedData) return cachedData;
  }

  try {
    const config: AxiosRequestConfig = {
      method: 'GET',
      url: endpoint,
      params
    };

    // Use batching for GET requests unless explicitly skipped
    const response = skipBatch
      ? await api(config)
      : await batchRequest<T>(config);

    // Cache successful responses
    if (!skipCache) {
      const cacheKey = getCacheKey(endpoint, params);
      setCacheEntry(cacheKey, response, cacheTTL);
    }

    return response;
  } catch (error) {
    console.error(`Error fetching data from ${endpoint}:`, error);
    throw error;
  }
};

// Create axios instance with default config

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Attach Oxy auth token to every request if available
api.interceptors.request.use(async (config) => {
  // Try SecureStore first, then AsyncStorage
  let token = null;
  try {
    // OxyProvider uses storageKeyPrefix="oxy_example" by default
    token = await SecureStore.getItemAsync('oxy_example_token');
    if (!token) {
      token = await AsyncStorage.getItem('oxy_example_token');
    }
  } catch (e) {
    // ignore
  }
  if (token) {
    config.headers = config.headers || {};
    config.headers['Authorization'] = `Bearer ${token}`;
  }
  return config;
});

export const cleanupPendingRequests = () => {
  try {
    // Clear any pending requests
    if (batchTimeout) {
      clearTimeout(batchTimeout);
      batchQueue.length = 0;
    }
    
    // Clear cache
    clearCache();
  } catch (error) {
    console.error('[API] Cleanup error:', error);
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

export default api;
