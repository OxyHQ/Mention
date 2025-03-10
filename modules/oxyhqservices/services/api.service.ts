import axios, { AxiosInstance, AxiosResponse, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { storeSecureData, getSecureData } from '../utils/storage';
import { OXY_API_CONFIG, OXY_CACHE_CONFIG } from '../config';
import { ERROR_MESSAGES } from '../constants';

// Import authEvents instead of showAuthBottomSheet
import { authEvents } from '../utils/authEvents';

// Cache implementation
interface CacheItem<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

// Extended request config with retry property
interface ExtendedAxiosRequestConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

class ApiService {
  private api: AxiosInstance;
  private isRefreshing: boolean = false;
  private failedQueue: Array<{
    resolve: (value?: unknown) => void;
    reject: (reason?: any) => void;
    config: any;
  }> = [];
  private cache: Map<string, CacheItem<any>> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();

  constructor() {
    this.api = axios.create({
      baseURL: OXY_API_CONFIG.BASE_URL,
      timeout: OXY_API_CONFIG.TIMEOUT,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    this.api.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
      try {
        const accessToken = await getSecureData<string>('accessToken');
        if (accessToken && config.headers) {
          config.headers.Authorization = `Bearer ${accessToken}`;
        }
        
        // Add abort controller to each request
        if (config.method && ['get', 'post', 'put', 'delete', 'patch'].includes(config.method)) {
          const controller = new AbortController();
          const requestId = this.getRequestId(config);
          
          this.abortControllers.set(requestId, controller);
          config.signal = controller.signal;
        }
        
        return config;
      } catch (error) {
        console.error('Error in request interceptor:', error);
        return config;
      }
    });

    this.api.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const originalRequest = error.config as ExtendedAxiosRequestConfig;
        
        // Clean up abort controller after request completes
        if (originalRequest) {
          const requestId = this.getRequestId(originalRequest);
          this.abortControllers.delete(requestId);
        }
        
        if (!originalRequest || error.response?.status !== 401 || originalRequest._retry) {
          return Promise.reject(error);
        }

        if (this.isRefreshing) {
          return new Promise((resolve, reject) => {
            this.failedQueue.push({ resolve, reject, config: originalRequest });
          });
        }

        originalRequest._retry = true;
        this.isRefreshing = true;

        try {
          const refreshToken = await getSecureData<string>('refreshToken');
          if (!refreshToken) {
            throw new Error('No refresh token available');
          }

          const response = await axios.post(`${OXY_API_CONFIG.BASE_URL}/auth/refresh`, { refreshToken });
          const { accessToken, refreshToken: newRefreshToken } = response.data;

          if (!accessToken) {
            throw new Error('Invalid refresh response');
          }

          // Store new tokens
          await Promise.all([
            storeSecureData('accessToken', accessToken),
            newRefreshToken ? storeSecureData('refreshToken', newRefreshToken) : Promise.resolve()
          ]);

          // Update authorization header
          this.api.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;
          if (originalRequest.headers) {
            originalRequest.headers['Authorization'] = `Bearer ${accessToken}`;
          }

          // Process queued requests
          this.processQueue(null, accessToken);

          // Retry original request
          return this.api(originalRequest);
        } catch (refreshError) {
          // Process queued requests with error
          this.processQueue(refreshError);

          // Clear tokens and show auth screen
          await Promise.all([
            storeSecureData('accessToken', null),
            storeSecureData('refreshToken', null)
          ]);
          // Use authEvents instead of direct function call
          authEvents.requireAuth();
          
          return Promise.reject(refreshError);
        } finally {
          this.isRefreshing = false;
        }
      }
    );
  }

  private processQueue(error: any, accessToken?: string): void {
    this.failedQueue.forEach(({ resolve, reject, config }) => {
      if (error) {
        reject(error);
      } else if (accessToken && config.headers) {
        config.headers['Authorization'] = `Bearer ${accessToken}`;
        resolve(this.api(config));
      }
    });
    this.failedQueue = [];
  }

  private getRequestId(config: any): string {
    const { method, url, params, data } = config;
    return `${method}:${url}:${JSON.stringify(params || {})}:${JSON.stringify(data || {})}`;
  }

  private getCacheKey(url: string, params?: any): string {
    return `${url}:${JSON.stringify(params || {})}`;
  }

  private isCacheValid<T>(cacheItem: CacheItem<T>): boolean {
    return Date.now() < cacheItem.expiresAt;
  }

  /**
   * Cancel all pending requests
   */
  public cancelAllRequests(): void {
    this.abortControllers.forEach(controller => {
      controller.abort();
    });
    this.abortControllers.clear();
  }

  /**
   * Cancel a specific request
   */
  public cancelRequest(requestId: string): void {
    const controller = this.abortControllers.get(requestId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(requestId);
    }
  }

  /**
   * Clear the entire cache
   */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Clear a specific cache entry
   */
  public clearCacheEntry(url: string, params?: any): void {
    const cacheKey = this.getCacheKey(url, params);
    this.cache.delete(cacheKey);
  }

  /**
   * Make a GET request with optional caching
   */
  public async get<T>(
    url: string, 
    config?: { 
      params?: any; 
      useCache?: boolean; 
      cacheTTL?: number;
      headers?: any;
    }
  ): Promise<AxiosResponse<T>> {
    const { params, useCache = false, cacheTTL = OXY_CACHE_CONFIG.DEFAULT_TTL } = config || {};
    
    if (useCache) {
      const cacheKey = this.getCacheKey(url, params);
      const cachedItem = this.cache.get(cacheKey) as CacheItem<T>;
      
      if (cachedItem && this.isCacheValid(cachedItem)) {
        return {
          data: cachedItem.data,
          status: 200,
          statusText: 'OK (cached)',
          headers: {},
          config: {}
        } as AxiosResponse<T>;
      }
    }
    
    try {
      const response = await this.api.get<T>(url, { ...config });
      
      if (useCache) {
        const cacheKey = this.getCacheKey(url, params);
        this.cache.set(cacheKey, {
          data: response.data,
          timestamp: Date.now(),
          expiresAt: Date.now() + cacheTTL
        });
      }
      
      return response;
    } catch (error) {
      this.handleRequestError(error);
      throw error;
    }
  }

  /**
   * Make a POST request
   */
  public async post<T>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>> {
    try {
      return await this.api.post<T>(url, data, config);
    } catch (error) {
      this.handleRequestError(error);
      throw error;
    }
  }

  /**
   * Make a PUT request
   */
  public async put<T>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>> {
    try {
      return await this.api.put<T>(url, data, config);
    } catch (error) {
      this.handleRequestError(error);
      throw error;
    }
  }

  /**
   * Make a DELETE request
   */
  public async delete<T>(url: string, config?: any): Promise<AxiosResponse<T>> {
    try {
      return await this.api.delete<T>(url, config);
    } catch (error) {
      this.handleRequestError(error);
      throw error;
    }
  }

  /**
   * Make a PATCH request
   */
  public async patch<T>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>> {
    try {
      return await this.api.patch<T>(url, data, config);
    } catch (error) {
      this.handleRequestError(error);
      throw error;
    }
  }

  /**
   * Handle common request errors
   */
  private handleRequestError(error: any): void {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      
      if (axiosError.code === 'ECONNABORTED') {
        console.error('Request timeout:', axiosError.message);
      } else if (axiosError.response) {
        console.error(`API Error ${axiosError.response.status}:`, 
          axiosError.response.data || ERROR_MESSAGES.DEFAULT);
      } else if (axiosError.request) {
        console.error('No response received:', axiosError.message);
      } else {
        console.error('Request error:', axiosError.message);
      }
    } else {
      console.error('Unexpected error:', error);
    }
  }
}

export const apiService = new ApiService();