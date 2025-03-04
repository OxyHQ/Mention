import axios, { AxiosInstance, AxiosResponse, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { storeSecureData, getSecureData } from '../utils/storage';
import { API_URL_OXY } from '../config';
import { showAuthBottomSheet } from '@/utils/auth';

class ApiService {
  private api: AxiosInstance;
  private isRefreshing: boolean = false;
  private failedQueue: Array<{
    resolve: (value?: unknown) => void;
    reject: (reason?: any) => void;
    config: any;
  }> = [];

  constructor() {
    this.api = axios.create({
      baseURL: API_URL_OXY,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    this.api.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
      try {
        const accessToken = await getSecureData<string>('accessToken');
        if (accessToken && config.headers) {
          config.headers.Authorization = `Bearer ${accessToken}`;
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
        const originalRequest = error.config;
        
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

          const response = await axios.post(`${API_URL_OXY}/auth/refresh`, { refreshToken });
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
          this.failedQueue.forEach(({ resolve, config }) => {
            if (config.headers) {
              config.headers['Authorization'] = `Bearer ${accessToken}`;
            }
            resolve(this.api(config));
          });
          this.failedQueue = [];

          // Retry original request
          return this.api(originalRequest);
        } catch (refreshError) {
          // Process queued requests with error
          this.failedQueue.forEach(({ reject }) => {
            reject(refreshError);
          });
          this.failedQueue = [];

          // Clear tokens and show auth screen
          await Promise.all([
            storeSecureData('accessToken', null),
            storeSecureData('refreshToken', null)
          ]);
          showAuthBottomSheet();
          
          return Promise.reject(refreshError);
        } finally {
          this.isRefreshing = false;
        }
      }
    );
  }

  // Public methods to access the axios instance
  public async get<T>(url: string, config?: any): Promise<AxiosResponse<T>> {
    return this.api.get<T>(url, config);
  }

  public async post<T>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>> {
    return this.api.post<T>(url, data, config);
  }

  public async put<T>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>> {
    return this.api.put<T>(url, data, config);
  }

  public async delete<T>(url: string, config?: any): Promise<AxiosResponse<T>> {
    return this.api.delete<T>(url, config);
  }

  public async patch<T>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>> {
    return this.api.patch<T>(url, data, config);
  }
}

export const apiService = new ApiService();