import { logger } from '@oxy.so/core/logger';
import { authenticatedClient } from "@/utils/api";
import { normalizeApiError } from "@/utils/apiError";

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
    } catch (error: unknown) {
      if (normalizeApiError(error).status === 409) {
        // Already reported — treat as success
        logger.warn("Already reported this content");
        return true;
      }
      logger.warn("Failed to report post", { error });
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
    } catch (error: unknown) {
      if (normalizeApiError(error).status === 409) {
        logger.warn("Already reported this user");
        return true;
      }
      logger.warn("Failed to report user", { error });
      return false;
    }
  }

  async reportRoom(roomId: string, categories: string[], details?: string): Promise<boolean> {
    try {
      await authenticatedClient.post("/reports", {
        reportedType: 'room',
        reportedId: roomId,
        categories,
        details
      });
      return true;
    } catch (error: unknown) {
      if (normalizeApiError(error).status === 409) {
        logger.warn("Already reported this room");
        return true;
      }
      logger.warn("Failed to report room", { error });
      return false;
    }
  }

  /**
   * A MENTION-OWNED job listing (`reportedType: 'job'`, `reportedId` is the
   * Mention job's own id) — the SAME generic report surface every other
   * subject here goes through. An EXTERNAL (Clarity-indexed-only) job never
   * calls this: it has no Mention `reportedId` to name, and its report goes to
   * `jobApplicationsService.reportExternalJob` instead, which proxies to
   * Clarity's own report mechanism (see issue #952: "route/report to the
   * correct Clarity/canonical-source mechanism rather than pretending Mention
   * owns the listing").
   */
  async reportJob(jobId: string, categories: string[], details?: string): Promise<boolean> {
    try {
      await authenticatedClient.post("/reports", {
        reportedType: 'job',
        reportedId: jobId,
        categories,
        details
      });
      return true;
    } catch (error: unknown) {
      if (normalizeApiError(error).status === 409) {
        logger.warn("Already reported this job");
        return true;
      }
      logger.warn("Failed to report job", { error });
      return false;
    }
  }
}

export const reportService = new ReportService();
