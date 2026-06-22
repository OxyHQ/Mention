import { authenticatedClient } from '@/utils/api';

export type LabelSeverity = 'low' | 'medium' | 'high' | 'critical';
export type LabelDefaultAction = 'show' | 'warn' | 'blur' | 'hide';

export interface LabelDefinition {
  slug: string;
  name: string;
  description?: string;
  severity?: LabelSeverity;
  defaultAction?: LabelDefaultAction;
}

export interface Labeler {
  _id: string;
  id?: string;
  name: string;
  description?: string;
  creatorId?: string;
  isOfficial?: boolean;
  isSubscribed?: boolean;
  subscriberCount: number;
  labelDefinitions?: LabelDefinition[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ContentLabel {
  _id: string;
  labelerId: string;
  targetType: string;
  targetId: string;
  labelSlug: string;
  reason?: string;
  createdAt?: string;
}

interface LabelerListResponse {
  items: Labeler[];
  total: number;
}

interface ContentLabelsResponse {
  items: ContentLabel[];
  total: number;
}

interface SubscribeResponse {
  success: boolean;
  subscribed: boolean;
}

class LabelerService {
  async list(params?: { search?: string }): Promise<LabelerListResponse> {
    const res = await authenticatedClient.get<LabelerListResponse>('/labelers', { params });
    return res.data;
  }

  async get(id: string): Promise<Labeler> {
    const res = await authenticatedClient.get<Labeler>(`/labelers/${id}`);
    return res.data;
  }

  async create(data: { name: string; description?: string; labelDefinitions?: LabelDefinition[] }): Promise<Labeler> {
    const res = await authenticatedClient.post<Labeler>('/labelers', data);
    return res.data;
  }

  async subscribe(id: string): Promise<SubscribeResponse> {
    const res = await authenticatedClient.post<SubscribeResponse>(`/labelers/${id}/subscribe`);
    return res.data;
  }

  async unsubscribe(id: string): Promise<SubscribeResponse> {
    const res = await authenticatedClient.delete<SubscribeResponse>(`/labelers/${id}/subscribe`);
    return res.data;
  }

  async applyLabel(labelerId: string, data: { targetType: string; targetId: string; labelSlug: string; reason?: string }): Promise<ContentLabel> {
    const res = await authenticatedClient.post<ContentLabel>(`/labelers/${labelerId}/labels`, data);
    return res.data;
  }

  async removeLabel(labelId: string): Promise<{ success: boolean }> {
    const res = await authenticatedClient.delete<{ success: boolean }>(`/labelers/labels/${labelId}`);
    return res.data;
  }

  async getContentLabels(type: string, id: string): Promise<ContentLabelsResponse> {
    const res = await authenticatedClient.get<ContentLabelsResponse>(`/labelers/content/${type}/${id}`);
    return res.data;
  }

  async updatePreferences(labelActions: Array<{ labelerId: string; labelSlug: string; action: string }>): Promise<{ success: boolean }> {
    const res = await authenticatedClient.put<{ success: boolean }>('/labelers/preferences', { labelActions });
    return res.data;
  }
}

export const labelerService = new LabelerService();
