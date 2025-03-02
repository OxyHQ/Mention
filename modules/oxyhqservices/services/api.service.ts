import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { getData } from '@/utils/storage';
import { API_URL_OXY } from '../config';

class ApiService {
  private api: AxiosInstance;

  constructor() {
    this.api = axios.create({
      baseURL: API_URL_OXY,
    });

    this.api.interceptors.request.use(async (config) => {
      const accessToken = await getData('accessToken');
      if (accessToken) {
        config.headers.Authorization = `Bearer ${accessToken}`;
      }
      return config;
    });
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