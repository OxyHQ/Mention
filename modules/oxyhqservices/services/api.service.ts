import axios, { AxiosInstance, AxiosResponse, AxiosError } from 'axios';
import { storeData, getSecureData, storeSecureData } from '../utils/storage';
import { API_URL_OXY } from '../config';

class ApiService {
  private api: AxiosInstance;
  private isRefreshing = false;
  private failedQueue: Array<{
    resolve: (value?: unknown) => void;
    reject: (reason?: any) => void;
    config: any;
  }> = [];

  constructor() {
    this.api = axios.create({
      baseURL: API_URL_OXY,
    });

    this.api.interceptors.request.use(async (config) => {
      const accessToken = await getSecureData('accessToken');
      if (accessToken) {
        config.headers.Authorization = `Bearer ${accessToken}`;
      }
      return config;
    });

    this.api.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const originalRequest = error.config;
        
        // If error is 401 and we're not already refreshing
        if (error.response?.status === 401 && !this.isRefreshing && originalRequest) {
          this.isRefreshing = true;
          
          // Process all failed requests after we get a new token
          const processQueue = (error: Error | null, token: string | null = null) => {
            this.failedQueue.forEach(({ resolve, reject, config }) => {
              if (!error && token) {
                config.headers.Authorization = `Bearer ${token}`;
                resolve(this.api(config));
              } else {
                reject(error);
              }
            });
            this.failedQueue = [];
          };
          
          try {
            const refreshToken = await getSecureData('refreshToken');
            if (!refreshToken) {
              processQueue(new Error('No refresh token available'));
              return Promise.reject(error);
            }
            
            const response = await this.api.post('/auth/refresh', { refreshToken });
            
            const { accessToken, refreshToken: newRefreshToken } = response.data;
            
            // Store new tokens securely
            await Promise.all([
              storeSecureData('accessToken', accessToken),
              storeSecureData('refreshToken', newRefreshToken || refreshToken)
            ]);
            
            // Process failed requests with new token
            processQueue(null, accessToken);
            
            // Retry the original request with new token
            if (originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${accessToken}`;
            }
            
            this.isRefreshing = false;
            return this.api(originalRequest);
          } catch (refreshError) {
            processQueue(new Error('Failed to refresh token'));
            this.isRefreshing = false;
            
            // Clear tokens on refresh failure
            await Promise.all([
              storeSecureData('accessToken', null),
              storeSecureData('refreshToken', null),
              storeData('user', null)
            ]);
            
            return Promise.reject(error);
          }
        }
        
        // If we're already refreshing, add this request to queue
        if (error.response?.status === 401 && this.isRefreshing && originalRequest) {
          return new Promise((resolve, reject) => {
            this.failedQueue.push({
              resolve,
              reject,
              config: originalRequest
            });
          });
        }
        
        return Promise.reject(error);
      }
    );
  }

  async get<T>(url: string): Promise<AxiosResponse<T>> {
    return this.api.get<T>(url);
  }

  async post<T>(url: string, data?: any): Promise<AxiosResponse<T>> {
    return this.api.post<T>(url, data);
  }

  async put<T>(url: string, data: any): Promise<AxiosResponse<T>> {
    return this.api.put<T>(url, data);
  }

  async patch<T>(url: string, data: any): Promise<AxiosResponse<T>> {
    return this.api.patch<T>(url, data);
  }

  async delete<T>(url: string): Promise<AxiosResponse<T>> {
    return this.api.delete<T>(url);
  }
}

export const apiService = new ApiService();