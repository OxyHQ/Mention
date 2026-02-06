import { authenticatedClient } from "@/utils/api";

export const REPORT_CATEGORIES = [
  { id: 'spam', label: 'Spam' },
  { id: 'hate_speech', label: 'Hate Speech' },
  { id: 'harassment', label: 'Harassment or Bullying' },
  { id: 'misinformation', label: 'Misinformation' },
  { id: 'explicit_content', label: 'Explicit Content' },
  { id: 'other', label: 'Other' },
] as const;

class ReportService {
  async reportPost(postId: string, categories: string[], details?: string): Promise<boolean> {
    try {
      await authenticatedClient.post("/reports", {
        reportedType: 'post',
        reportedId: postId,
        categories,
        details
      });
      return true;
    } catch (error: any) {
      if (error?.response?.status === 409) {
        // Already reported
        console.warn("Already reported this content");
      }
      return false;
    }
  }

  async reportUser(userId: string, categories: string[], details?: string): Promise<boolean> {
    try {
      await authenticatedClient.post("/reports", {
        reportedType: 'user',
        reportedId: userId,
        categories,
        details
      });
      return true;
    } catch (error) {
      console.warn("Failed to report user", error);
      return false;
    }
  }
}

export const reportService = new ReportService();
