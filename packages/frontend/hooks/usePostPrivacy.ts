import { useMemo } from 'react';
import { useOxy } from '@oxyhq/services';
import { usePrivacyControls } from './usePrivacyControls';
import { useCurrentUserPrivacySettings } from './usePrivacySettings';
import { extractAuthorId } from '@/utils/postUtils';

interface PostPrivacyResult {
    isAuthorBlocked: boolean;
    isAuthorRestricted: boolean;
    hideLikeCounts: boolean;
    hideShareCounts: boolean;
    hideReplyCounts: boolean;
    hideSaveCounts: boolean;
}

export function usePostPrivacy(post: any): PostPrivacyResult {
    const { blockedSet, restrictedSet } = usePrivacyControls({ autoRefresh: false });
    const currentUserPrivacySettings = useCurrentUserPrivacySettings();

    return useMemo(() => {
        const authorId = extractAuthorId(post);
        const isAuthorBlocked = authorId ? blockedSet.has(authorId) : false;
        const isAuthorRestricted = authorId ? restrictedSet.has(authorId) : false;

        return {
            isAuthorBlocked,
            isAuthorRestricted,
            hideLikeCounts: currentUserPrivacySettings?.hideLikeCounts || false,
            hideShareCounts: currentUserPrivacySettings?.hideShareCounts || false,
            hideReplyCounts: currentUserPrivacySettings?.hideReplyCounts || false,
            hideSaveCounts: currentUserPrivacySettings?.hideSaveCounts || false,
        };
    }, [post, blockedSet, restrictedSet, currentUserPrivacySettings]);
}

