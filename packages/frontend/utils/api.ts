import { toast } from "sonner";
import { API_URL } from "@/config";
import { OxyServices } from "@oxyhq/services";


const oxy = new OxyServices(
  {
    baseURL: "http://localhost:3001",
  }
);


// API Configuration
const API_CONFIG = {
  baseURL: API_URL,
  endpoints: {
    health: '/api/health',
    userSessions: '/api/user/sessions',
    messages: '/api/messages',
  },
};

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  error?: string;
  data?: T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public response?: any
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Base authenticated fetch function
async function makeAuthenticatedRequest<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  // Ensure endpoint starts with /
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${API_URL}${normalizedEndpoint}`;
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  // Try to get authentication token
  const authToken = await oxy.getAccessToken();
  
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
    console.log("[Auth API] Token added to request");
  } else {
    console.log("[Auth API] No authentication token available");
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMessage = data.message || data.error || `HTTP ${response.status}`;
      console.error('[Auth API] Request failed:', errorMessage);
      
      throw new ApiError(
        errorMessage,
        response.status,
        data
      );
    }

    return data;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    
    console.error('Auth API Request failed:', error);
    throw new ApiError(
      error instanceof Error ? error.message : 'Network request failed'
    );
  }
}

// Authenticated fetch object with HTTP methods
export const authFetch = {
  async get<T = any>(endpoint: string): Promise<T> {
    try {
      return await makeAuthenticatedRequest<T>(endpoint, { method: 'GET' });
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to fetch data';
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) {
        toast.error(`Get request failed: ${errorMessage}`);
      }
      throw error;
    }
  },

  async post<T = any>(endpoint: string, data: any): Promise<T> {
    try {
      return await makeAuthenticatedRequest<T>(endpoint, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to create data';
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) {
        toast.error(`Post request failed: ${errorMessage}`);
      }
      throw error;
    }
  },

  async put<T = any>(endpoint: string, data: any): Promise<T> {
    try {
      return await makeAuthenticatedRequest<T>(endpoint, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to update data';
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) {
        toast.error(`Put request failed: ${errorMessage}`);
      }
      throw error;
    }
  },

  async patch<T = any>(endpoint: string, data: any): Promise<T> {
    try {
      return await makeAuthenticatedRequest<T>(endpoint, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to update data';
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) {
        toast.error(`Patch request failed: ${errorMessage}`);
      }
      throw error;
    }
  },

  async delete<T = any>(endpoint: string): Promise<T> {
    try {
      return await makeAuthenticatedRequest<T>(endpoint, { method: 'DELETE' });
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to delete data';
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) {
        toast.error(`Delete request failed: ${errorMessage}`);
      }
      throw error;
    }
  }
};

// Legacy exports for backward compatibility
export const postData = async (endpoint: string, data: any) => {
  return authFetch.post(endpoint, data);
};

export const putData = async (endpoint: string, data: any) => {
  return authFetch.put(endpoint, data);
};

export const deleteData = async (endpoint: string) => {
  return authFetch.delete(endpoint);
};

export const getData = async (endpoint: string) => {
  return authFetch.get(endpoint);
};

// Default export for legacy compatibility
export default authFetch;
