import axios from "axios";
import { toast } from "sonner";
import { getData, storeData } from './storage';
import { router } from 'expo-router';
import { getSocket, disconnectSocket } from './socket';

const API_URL = process.env.API_URL || "http://localhost:3000/api";

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

export const fetchData = async (endpoint: string, config?: any) => {
  try {
    const response = await api.get(endpoint, config);
    return response.data;
  } catch (error) {
    toast.error(`Error fetching data from ${endpoint}:` + error);
    throw error;
  }
};

export const deleteData = async (endpoint: string, data?: any) => {
  try {
    const response = await api.delete(endpoint, data);
    return response.data;
  } catch (error) {
    toast.error(`Error deleting data from ${endpoint}:` + error);
    throw error;
  }
};

export const postData = async (endpoint: string, data: any) => {
  try {
    const response = await api.post(endpoint, data);
    return response.data;
  } catch (error) {
    toast.error(`Error posting data to ${endpoint}:` + error);
    throw error;
  }
};

export const putData = async (endpoint: string, data: any) => {
  try {
    const response = await api.put(endpoint, data);
    return response.data;
  } catch (error) {
    toast.error(`Error putting data to ${endpoint}:` + error);
    throw error;
  }
};

export const patchData = async (endpoint: string, data: any) => {
  try {
    const response = await api.patch(endpoint, data);
    return response.data;
  } catch (error) {
    toast.error(`Error patching data to ${endpoint}:` + error);
    throw error;
  }
}

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
export default api;
