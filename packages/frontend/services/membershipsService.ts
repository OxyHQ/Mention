import { authenticatedClient } from '@/utils/api';
import type {
  CreateMembershipCommunityRequest,
  CreateMembershipTierRequest,
  UpdateMembershipTierRequest,
  MembershipTier,
  CreateMembershipContentRequest,
  MembershipCommunity,
  MembershipContent,
  MembershipContentTeaser,
  MembershipLandingResponse,
} from '@mention/shared-types';

export interface MembershipContentPage {
  items: MembershipContent[];
  nextCursor: string | null;
}
const base = '/membership-communities';
const segment = encodeURIComponent;
export const membershipsService = {
  async mine(signal?: AbortSignal) {
    return (
      await authenticatedClient.get<{
        owned: MembershipCommunity[];
        joined: MembershipCommunity[];
      }>(`${base}/mine`, { signal })
    ).data;
  },
  async landing(id: string, signal?: AbortSignal) {
    return (
      await authenticatedClient.get<MembershipLandingResponse>(`${base}/${segment(id)}/landing`, {
        signal,
      })
    ).data;
  },
  async create(input: CreateMembershipCommunityRequest) {
    return (await authenticatedClient.post<MembershipCommunity>(base, input)).data;
  },
  async update(
    id: string,
    input: Partial<Pick<MembershipCommunity, 'name' | 'description' | 'visibility' | 'status'>>,
  ) {
    return (await authenticatedClient.patch<MembershipCommunity>(`${base}/${segment(id)}`, input))
      .data;
  },
  async join(id: string, tierId: string) {
    await authenticatedClient.put(`${base}/${segment(id)}/membership`, { tierId });
  },
  async leave(id: string) {
    await authenticatedClient.delete(`${base}/${segment(id)}/membership`);
  },
  async badge(id: string, publicBadge: boolean) {
    await authenticatedClient.patch(`${base}/${segment(id)}/membership`, { publicBadge });
  },
  async content(id: string, cursor?: string, parentContentId?: string, signal?: AbortSignal) {
    return (
      await authenticatedClient.get<MembershipContentPage>(`${base}/${segment(id)}/content`, {
        params: { cursor, parentContentId },
        signal,
      })
    ).data;
  },
  async createContent(id: string, input: CreateMembershipContentRequest) {
    return (
      await authenticatedClient.post<MembershipContent>(`${base}/${segment(id)}/content`, input)
    ).data;
  },
  async readContent(id: string, signal?: AbortSignal) {
    return (
      await authenticatedClient.get<MembershipContent>(`${base}/content/${segment(id)}`, {
        signal,
      })
    ).data;
  },
  async removeContent(id: string) {
    await authenticatedClient.delete(`${base}/content/${segment(id)}`);
  },
  async vote(id: string, optionId: string) {
    await authenticatedClient.put(`${base}/content/${segment(id)}/vote`, { optionId });
  },
  async report(id: string, reason: string) {
    await authenticatedClient.post(`${base}/content/${segment(id)}/reports`, { reason });
  },
  async revoke(id: string, memberId: string) {
    await authenticatedClient.delete(`${base}/${segment(id)}/members/${segment(memberId)}`);
  },
  async insights(id: string, signal?: AbortSignal) {
    return (
      await authenticatedClient.get<{ membershipsByState: { state: string; total: number }[] }>(
        `${base}/${segment(id)}/insights`,
        { signal },
      )
    ).data;
  },
  async discardUpload(id: string, mediaId: string) {
    await authenticatedClient.delete(`${base}/${segment(id)}/media/${segment(mediaId)}`);
  },
  async upload(id: string, bytes: ArrayBuffer, mime: string) {
    return (
      await authenticatedClient.post<{ id: string; mime: string; size: number }>(
        `${base}/${segment(id)}/media`,
        bytes,
        { headers: { 'Content-Type': mime } },
      )
    ).data;
  },
  async createTier(id: string, input: CreateMembershipTierRequest) {
    return (await authenticatedClient.post<MembershipTier>(`${base}/${segment(id)}/tiers`, input))
      .data;
  },
  async updateTier(id: string, tierId: string, input: UpdateMembershipTierRequest) {
    await authenticatedClient.patch(`${base}/${segment(id)}/tiers/${segment(tierId)}`, input);
  },
  async teaser(id: string, signal?: AbortSignal) {
    return (
      await authenticatedClient.get<MembershipContentTeaser>(
        `${base}/content/${segment(id)}/teaser`,
        { signal },
      )
    ).data;
  },
  async resolveReport(id: string, reportId: string) {
    await authenticatedClient.post(`${base}/${segment(id)}/reports/${segment(reportId)}/resolve`);
  },
  async reports(id: string, signal?: AbortSignal) {
    return (
      await authenticatedClient.get<
        { id: string; contentId: string; reason: string; createdAt: string }[]
      >(`${base}/${segment(id)}/reports`, { signal })
    ).data;
  },
  async directory(id: string, signal?: AbortSignal) {
    return (
      await authenticatedClient.get<{ oxyUserId: string }[]>(`${base}/${segment(id)}/directory`, {
        signal,
      })
    ).data;
  },
  async download(contentId: string, mediaId: string) {
    return (
      await authenticatedClient.get<{ url: string; expiresIn: number }>(
        `${base}/content/${segment(contentId)}/media/${segment(mediaId)}`,
      )
    ).data;
  },
};
